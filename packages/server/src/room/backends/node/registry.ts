/**
 * In-process {@link Rooms} for a single Node/Bun host, the Road-2 backend a
 * self-host or Tauri shell binds instead of the Cloudflare Durable Object
 * (ADR-0057). One `RoomCore` per room lives in a `Map`; a `bun:sqlite` file
 * per room persists its update log. A single process is always the one writer
 * for every room it holds, so it needs neither the DO's single-writer
 * guarantee nor its hibernation restore (the connection set never gets wiped).
 *
 * ## The WebSocket-upgrade impedance
 *
 * Cloudflare returns a 101 `Response` from `fetch`; Bun cannot. Bun upgrades
 * by calling `server.upgrade(request, { data })` (which returns a boolean and
 * emits the 101 itself) and then delivers the live socket to the top-level
 * `websocket` handler. So this backend splits {@link ResolvedRoom.handleUpgrade}
 * across two points that share one `Map`:
 *
 *   - `rooms.get(name).handleUpgrade(...)` calls `server.upgrade`, passing the
 *     resolved identity as `ws.data` and ensuring the room exists so the
 *     accept handler can find it.
 *   - {@link createNodeRooms.websocket}'s `open`/`message`/`close` drive the
 *     matching `RoomCore` resolved from `ws.data.roomName`.
 *
 * The `server` instance only exists after `Bun.serve(...)` returns, so the
 * entry calls {@link createNodeRooms.bindServer} once before serving traffic.
 *
 * ## Eviction
 *
 * When a room's last socket closes, a grace timer compacts the log and closes
 * the sqlite handle, evicting the room from the `Map` (a connecting socket
 * cancels it first). A truncate-checkpoint runs before close so the WAL
 * sidecars do not persist (the macOS persistent-WAL caveat); keep `dir` on a
 * local disk, never a networked filesystem.
 */

import { Database } from 'bun:sqlite';
import type { Server, ServerWebSocket, WebSocketHandler } from 'bun';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { UserId } from '@epicenter/auth';
import { MAIN_SUBPROTOCOL, parseSubprotocols } from '@epicenter/sync';
import type {
	ResolvedRoom,
	RoomUpgrade,
	Rooms,
} from '../../contracts.js';
import { type RoomCore, createRoomCore } from '../../core.js';
import type { Connection } from '../../../types.js';
import { createBunSqliteUpdateLog } from './update-log.js';

/**
 * Grace window between a room's last socket closing and its eviction
 * (compact + close + drop from the `Map`). Mirrors the Cloudflare backend's
 * 30 s post-empty compaction delay.
 */
const EVICTION_GRACE_MS = 30_000;

/**
 * Per-connection data Bun carries on `ws.data`, set at `server.upgrade` and
 * read back in the `websocket` handler. Carries `roomName` so the handler
 * resolves the right `RoomCore`, plus the resolved identity the
 * {@link Connection} attachment is built from.
 */
type NodeRoomSocketData = {
	roomName: string;
	userId: UserId;
	nodeId: string;
};

/** A live room: its core, its open sqlite handle, and any pending eviction. */
type RoomEntry = {
	name: string;
	core: RoomCore;
	db: Database;
	evictionTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * Build an in-process room registry rooted at `dir` (one sqlite file per
 * room). Returns the {@link Rooms} the deployment passes to `resolveRooms`,
 * the `websocket` handler it passes to `Bun.serve`, and `bindServer` to hand
 * back the `Server` once `Bun.serve` returns.
 */
export function createNodeRooms({ dir }: { dir: string }): {
	rooms: Rooms;
	websocket: WebSocketHandler<NodeRoomSocketData>;
	bindServer: (server: Server<NodeRoomSocketData>) => void;
} {
	const entries = new Map<string, RoomEntry>();
	let server: Server<NodeRoomSocketData> | null = null;

	/** Flat, filesystem-safe filename: sha256 of the opaque room name. */
	function roomFilePath(name: string): string {
		const hash = createHash('sha256').update(name).digest('hex');
		return join(dir, `${hash}.sqlite`);
	}

	/** Resolve a room's entry, lazily opening its sqlite file and core. */
	function getOrCreate(name: string): RoomEntry {
		const existing = entries.get(name);
		if (existing) return existing;

		const db = new Database(roomFilePath(name), { create: true });
		// Self-identifying: the file knows which opaque room name it holds, so a
		// directory of hashed files stays debuggable.
		db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
		db.query('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
			'roomName',
			name,
		);

		const updateLog = createBunSqliteUpdateLog(db);
		const core = createRoomCore({ updateLog });
		const entry: RoomEntry = { name, core, db, evictionTimer: null };
		entries.set(name, entry);
		return entry;
	}

	function cancelEviction(entry: RoomEntry): void {
		if (!entry.evictionTimer) return;
		clearTimeout(entry.evictionTimer);
		entry.evictionTimer = null;
	}

	function scheduleEviction(entry: RoomEntry): void {
		if (entry.evictionTimer) return;
		entry.evictionTimer = setTimeout(() => {
			entry.evictionTimer = null;
			if (entry.core.connectionCount > 0) return;
			entry.core.compact();
			// Truncate-checkpoint before close so the -wal/-shm sidecars do not
			// survive on macOS (persistent WAL by default there).
			try {
				entry.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
			} catch {
				/* best-effort; close still proceeds */
			}
			entry.db.close();
			entries.delete(entry.name);
		}, EVICTION_GRACE_MS);
	}

	const rooms: Rooms = {
		get(name: string): ResolvedRoom {
			return {
				sync: (body) => Promise.resolve(getOrCreate(name).core.sync(body)),
				getDoc: () => Promise.resolve(getOrCreate(name).core.getDoc()),
				handleUpgrade: ({ request, userId, nodeId }: RoomUpgrade) => {
					if (!server) {
						// bindServer must run before any traffic; this is a wiring bug.
						return Promise.resolve(
							new Response('room server not bound', { status: 500 }),
						);
					}
					// Ensure the room exists so the `open` handler finds it.
					getOrCreate(name);

					// Echo the main subprotocol if offered, completing the handshake
					// the client opened with `<MAIN_SUBPROTOCOL>, bearer.<token>`.
					const headers = new Headers();
					const offered = parseSubprotocols(
						request.headers.get('sec-websocket-protocol'),
					);
					if (offered.includes(MAIN_SUBPROTOCOL)) {
						headers.set('sec-websocket-protocol', MAIN_SUBPROTOCOL);
					}

					const data: NodeRoomSocketData = { roomName: name, userId, nodeId };
					const upgraded = server.upgrade(request, { data, headers });
					if (!upgraded) {
						return Promise.resolve(
							new Response('expected a WebSocket upgrade', { status: 426 }),
						);
					}
					// Bun has hijacked the socket and already sent the 101; this
					// placeholder Response is discarded. Hono requires a Response.
					return Promise.resolve(new Response(null));
				},
			} satisfies ResolvedRoom;
		},
	};

	const websocket: WebSocketHandler<NodeRoomSocketData> = {
		// Binary Yjs frames arrive as Bun's default `Buffer`, a `Uint8Array`
		// subclass RoomCore's decode path accepts directly (no `binaryType`
		// override and no conversion needed).
		open(ws: ServerWebSocket<NodeRoomSocketData>) {
			const { roomName, userId, nodeId } = ws.data;
			const entry = getOrCreate(roomName);
			cancelEviction(entry);
			const connection: Connection = {
				userId,
				nodeId,
				connectedAt: Date.now(),
				actions: {},
			};
			entry.core.addConnection(ws, connection);
		},
		message(ws: ServerWebSocket<NodeRoomSocketData>, message) {
			const entry = entries.get(ws.data.roomName);
			if (!entry) return;
			entry.core.handleMessage(ws, message);
		},
		close(ws: ServerWebSocket<NodeRoomSocketData>, code) {
			const entry = entries.get(ws.data.roomName);
			if (!entry) return;
			entry.core.removeConnection(ws, code);
			if (entry.core.connectionCount === 0) scheduleEviction(entry);
		},
	};

	return {
		rooms,
		websocket,
		bindServer(s: Server<NodeRoomSocketData>): void {
			server = s;
		},
	};
}
