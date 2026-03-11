/**
 * Self-contained Yjs sync room for Cloudflare Durable Objects.
 *
 * Everything a sync room needs lives in this file: SQLite persistence,
 * WebSocket lifecycle, connection management, and the abstract base class.
 * The only external dependency is `sync-handlers.ts` for the Yjs wire
 * protocol (encode/decode/dispatch). Subclasses (`WorkspaceRoom`,
 * `DocumentRoom`) import from here and nowhere else.
 *
 * ## Module structure
 *
 * - {@link createConnectionHub} — WebSocket connection map + dispatch + broadcast
 * - {@link BaseSyncRoom} — DO base class wiring persistence + connections together
 */

import { DurableObject } from 'cloudflare:workers';
import { decodeSyncRequest, stateVectorsEqual } from '@epicenter/sync';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from './constants';
import {
	type ConnectionState,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	safeBroadcast,
	swallow,
} from './sync-handlers';

// ============================================================================
// SyncRoomConfig
// ============================================================================

/**
 * Configuration for customizing sync room behavior.
 *
 * Passed to the {@link BaseSyncRoom} constructor. Keeps customization
 * explicit and co-located with the subclass constructor.
 */
type SyncRoomConfig = {
	/**
	 * Whether to enable Yjs garbage collection.
	 *
	 * - `true` — workspace rooms that don't need version history
	 * - `false` — document rooms that preserve delete history so
	 *   `Y.snapshot()` can reconstruct past states
	 */
	gc: boolean;
};

// ============================================================================
// BaseSyncRoom
// ============================================================================

/**
 * Base class for Yjs sync rooms backed by Cloudflare Durable Objects.
 *
 * Owns the shared infrastructure that every sync room needs: SQLite update log
 * persistence, WebSocket lifecycle via the Hibernation API, HTTP sync via RPC,
 * and connection management. Subclasses customize via {@link SyncRoomConfig}:
 *
 * - `gc` — Y.Doc garbage collection via {@link SyncRoomConfig}
 * - {@link BaseSyncRoom.initHub} — create connection hub with optional disconnect callback
 *
 * ## Worker → DO interface
 *
 * The Hono Worker in `app.ts` calls into DOs via two mechanisms:
 *
 * - **RPC** (`stub.sync()`, `stub.getDoc()`) — for HTTP sync and snapshot
 *   bootstrap. Direct method calls avoid Request/Response serialization
 *   overhead for binary payloads. The Worker handles HTTP concerns (status
 *   codes, content-type headers); the DO handles only Yjs logic.
 * - **fetch** (`stub.fetch(request)`) — for WebSocket upgrades only, since
 *   the 101 Switching Protocols handshake requires HTTP request/response
 *   semantics. After upgrade, all sync traffic flows through the Hibernation
 *   API callbacks (`webSocketMessage`, `webSocketClose`, `webSocketError`).
 *
 * ## Storage model
 *
 * Append-only update log in DO SQLite with opportunistic cold-start
 * compaction. Initialized inside `blockConcurrencyWhile` in the constructor.
 *
 * ## Auth & room isolation
 *
 * Handled upstream by `authGuard` middleware in app.ts. The Worker validates
 * the session (cookie or `?token=` query param for WebSocket) via Better Auth
 * before calling RPC methods or forwarding fetch. The DO itself does not
 * re-validate — it trusts the Worker boundary.
 *
 * Room names are user-scoped: the Worker prefixes `user:{userId}:` to the
 * client-provided room name before calling `idFromName()`. This ensures each
 * user's documents are isolated in separate DO instances, even if multiple
 * users create documents with the same name (e.g., "tab-manager").
 *
 * We chose user-scoped keys (Google Docs model) over org-scoped keys
 * (Vercel/Supabase model) because most workspaces hold personal data.
 * For enterprise self-hosted, the deployment itself is the org boundary.
 * See `getWorkspaceStub` in app.ts for the full rationale.
 */
export class BaseSyncRoom extends DurableObject {
	/**
	 * The shared Yjs document for this room.
	 *
	 * Initialized inside `ctx.blockConcurrencyWhile()` in the constructor.
	 * The definite assignment assertion (`!`) is safe because of two
	 * guarantees working together:
	 *
	 * 1. **Cloudflare runtime guarantee**: `blockConcurrencyWhile` prevents
	 *    the DO from receiving any incoming requests (`fetch`, `webSocketMessage`,
	 *    etc.) until the initialization promise resolves. So no method on this
	 *    class can run before `doc` is set.
	 *
	 * 2. **Synchronous async callback**: The callback passed to
	 *    `blockConcurrencyWhile` contains no `await`, so it executes to
	 *    completion synchronously. This means `doc` is assigned before the
	 *    constructor returns — so subclass constructors (e.g. `DocumentRoom`)
	 *    can safely access `this.doc` after `super()`.
	 *
	 * If an `await` is ever added to the `blockConcurrencyWhile` callback,
	 * guarantee (2) breaks and subclass constructor access becomes unsafe.
	 *
	 * @see {@link https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile | blockConcurrencyWhile docs}
	 */
	protected doc!: Y.Doc;

	/**
	 * WebSocket connection hub managing upgrade, dispatch, and lifecycle.
	 *
	 * Set inside {@link initHub}, which each subclass must call after `super()`.
	 * Safe because the Cloudflare runtime won't deliver requests until the
	 * constructor (including the subclass portion) has fully returned.
	 */
	private hub!: ConnectionHub;
	private awareness!: Awareness;

	constructor(ctx: DurableObjectState, env: Env, config: SyncRoomConfig) {
		super(ctx, env);

		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		ctx.blockConcurrencyWhile(async () => {
			this.doc = new Y.Doc({ gc: config.gc });
			this.awareness = new Awareness(this.doc);

			// --- Update log: DDL + cold-start load + compaction + live persist ---

			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS updates (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data BLOB NOT NULL
				)
			`);

			const rows = ctx.storage.sql
				.exec('SELECT data FROM updates ORDER BY id')
				.toArray();

			if (rows.length > 0) {
				const merged = Y.mergeUpdatesV2(
					rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
				);
				Y.applyUpdateV2(this.doc, merged);

				if (rows.length > 1 && merged.byteLength <= MAX_COMPACTED_BYTES) {
					ctx.storage.transactionSync(() => {
						ctx.storage.sql.exec('DELETE FROM updates');
						ctx.storage.sql.exec(
							'INSERT INTO updates (data) VALUES (?)',
							merged,
						);
					});
				}
			}

			this.doc.on('updateV2', (update: Uint8Array) => {
				ctx.storage.sql.exec('INSERT INTO updates (data) VALUES (?)', update);
			});
		});
	}

	/**
	 * Create and register the WebSocket connection hub.
	 *
	 * Must be called by each subclass constructor after `super()`. Pass
	 * `onAllDisconnected` to run cleanup when the last WebSocket client leaves.
	 *
	 * Safe to call after `super()` because the constructor hasn't returned yet,
	 * so the Cloudflare runtime won't deliver any requests until initialization
	 * is complete.
	 *
	 * @example
	 * ```typescript
	 * constructor(ctx: DurableObjectState, env: Env) {
	 *   super(ctx, env, { gc: false });
	 *   this.initHub({ onAllDisconnected: () => this.saveSnapshot('Auto-save') });
	 * }
	 * ```
	 */
	protected initHub(options?: { onAllDisconnected?: () => void }) {
		this.hub = createConnectionHub({
			ctx: this.ctx,
			doc: this.doc,
			awareness: this.awareness,
			onAllDisconnected: options?.onAllDisconnected,
		});
		this.hub.restoreHibernated();
	}

	// --- fetch: WebSocket upgrades only ---

	/**
	 * Only handles WebSocket upgrades. HTTP operations (sync, snapshot) are
	 * exposed as RPC methods called directly on the stub, avoiding the overhead
	 * of constructing/parsing Request/Response objects for binary payloads.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.hub.upgrade();
		}
		return new Response('Method not allowed', { status: 405 });
	}

	// --- RPC methods (called via stub.sync() / stub.getDoc()) ---

	/**
	 * HTTP sync via RPC.
	 *
	 * Binary body format: `[length-prefixed stateVector][length-prefixed update]`
	 * (encoded via `encodeSyncRequest` from sync-core).
	 *
	 * 1. Applies client update to the live doc (triggers `updateV2` → SQLite
	 *    persist + broadcast to WebSocket peers).
	 * 2. Compares state vectors — returns `null` if already in sync (caller
	 *    maps to 304).
	 * 3. Otherwise returns the binary diff the client is missing.
	 */
	async sync(body: Uint8Array): Promise<Uint8Array | null> {
		const { stateVector: clientSV, update } = decodeSyncRequest(body);

		if (update.byteLength > 0) {
			Y.applyUpdateV2(this.doc, update, 'http');
		}

		const serverSV = Y.encodeStateVector(this.doc);
		if (stateVectorsEqual(serverSV, clientSV)) {
			return null;
		}

		return Y.encodeStateAsUpdateV2(this.doc, clientSV);
	}

	/**
	 * Snapshot bootstrap via RPC.
	 *
	 * Returns the full doc state via `Y.encodeStateAsUpdateV2`. Clients apply
	 * this with `Y.applyUpdateV2` to hydrate their local doc before opening a
	 * WebSocket, reducing the initial sync payload size.
	 */
	async getDoc(): Promise<Uint8Array> {
		return Y.encodeStateAsUpdateV2(this.doc);
	}

	// --- WebSocket lifecycle ---

	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		this.hub.dispatch(ws, message);
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		this.hub.close(ws, code, reason);
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		this.hub.error(ws);
	}
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Max compacted snapshot size (2 MB). Cloudflare DO SQLite enforces a hard
 * 2 MB per-row BLOB limit.
 *
 * On cold start, all update rows are merged into a single snapshot via
 * `Y.mergeUpdatesV2`. If the merged result fits under this limit, all rows
 * are atomically replaced with a single compacted row. This collapses
 * thousands of tiny keystroke-level updates into one row, dramatically
 * improving future cold-start load times.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/** Per-connection metadata persisted via `ws.serializeAttachment` to survive hibernation. */
type WsAttachment = {
	controlledClientIds: number[];
};

// ============================================================================
// createConnectionHub
// ============================================================================

/** WebSocket connection hub returned by {@link createConnectionHub}. */
type ConnectionHub = ReturnType<typeof createConnectionHub>;

/**
 * Create a WebSocket connection hub that manages the full lifecycle:
 * upgrade, dispatch, broadcast, close, error, and hibernation restoration.
 *
 * Owns the `Map<WebSocket, ConnectionState>` — the only shared mutable state
 * in the DO's WebSocket handling. Delegates protocol logic to `sync-handlers.ts`.
 */
function createConnectionHub({
	ctx,
	doc,
	awareness,
	onAllDisconnected,
}: {
	ctx: DurableObjectState;
	doc: Y.Doc;
	awareness: Awareness;
	onAllDisconnected?: () => void;
}) {
	const states = new Map<WebSocket, ConnectionState>();

	return {
		/** Number of active WebSocket connections. */
		get size() {
			return states.size;
		},

		/**
		 * Restore connections that survived hibernation.
		 *
		 * Iterates `ctx.getWebSockets()`, deserializes each attachment to recover
		 * controlled awareness client IDs, and re-registers sync handlers.
		 * Must be called inside `blockConcurrencyWhile`.
		 */
		restoreHibernated() {
			for (const ws of ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as WsAttachment | null;
				if (!attachment) continue;

				const { state } = handleWsOpen(doc, awareness, ws);
				for (const id of attachment.controlledClientIds) {
					state.controlledClientIds.add(id);
				}
				states.set(ws, state);
			}
		},

		/**
		 * Handle a WebSocket upgrade request.
		 *
		 * Creates a WebSocketPair, accepts via the Hibernation API, registers
		 * sync handlers, sends initial messages (SyncStep1 + awareness), and
		 * returns the 101 response.
		 */
		upgrade(): Response {
			const pair = new WebSocketPair();
			const [client, server] = [pair[0], pair[1]];

			ctx.acceptWebSocket(server);

			const { initialMessages, state } = handleWsOpen(doc, awareness, server);
			states.set(server, state);

			server.serializeAttachment({
				controlledClientIds: [],
			} satisfies WsAttachment);

			for (const msg of initialMessages) {
				server.send(msg);
			}

			return new Response(null, { status: 101, webSocket: client });
		},

		/**
		 * Dispatch an incoming WebSocket message: validate size, decode via
		 * sync-handlers, process effects (respond, broadcast, persist attachment).
		 */
		dispatch(ws: WebSocket, message: ArrayBuffer | string) {
			const state = states.get(ws);
			if (!state) return;

			const byteLength =
				message instanceof ArrayBuffer ? message.byteLength : message.length;
			if (byteLength > MAX_PAYLOAD_BYTES) {
				ws.close(1009, 'Message too large');
				return;
			}

			const data =
				message instanceof ArrayBuffer
					? new Uint8Array(message)
					: new TextEncoder().encode(message);

			const { data: effects, error } = handleWsMessage(data, state);
			if (error) {
				console.error(error.message);
				return;
			}

			for (const effect of effects) {
				switch (effect.type) {
					case 'respond':
						ws.send(effect.data);
						break;
					case 'broadcast':
						safeBroadcast(states, ws, effect.data);
						break;
					case 'persistAttachment':
						ws.serializeAttachment({
							controlledClientIds: [...state.controlledClientIds],
						} satisfies WsAttachment);
						break;
				}
			}
		},

		/**
		 * Clean up a closed WebSocket: unregister handlers, remove from map,
		 * and fire `onAllDisconnected` if this was the last connection.
		 */
		close(ws: WebSocket, code: number, reason: string) {
			const state = states.get(ws);
			if (!state) return;

			handleWsClose(state);
			states.delete(ws);

			swallow(() => ws.close(code, reason));

			if (states.size === 0) {
				onAllDisconnected?.();
			}
		},

		/**
		 * Handle a WebSocket error by closing with code 1011.
		 */
		error(ws: WebSocket) {
			this.close(ws, 1011, 'WebSocket error');
		},
	};
}
