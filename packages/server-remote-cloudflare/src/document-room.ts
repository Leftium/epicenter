import { DurableObject } from 'cloudflare:workers';
import { decodeSyncRequest, stateVectorsEqual } from '@epicenter/sync';
import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from './constants';
import {
	Awareness,
	type ConnectionState,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	safeBroadcast,
	swallow,
} from './sync-handlers';

type WsAttachment = {
	controlledClientIds: number[];
};

/**
 * Max compacted snapshot size (2 MB). Cloudflare DO SQLite enforces a hard
 * 2 MB per-row BLOB limit.
 *
 * On cold start, all update rows are merged into a single snapshot via
 * `Y.mergeUpdatesV2`. If the merged result fits under this limit, all rows
 * are atomically replaced with a single compacted row. This collapses
 * thousands of tiny keystroke-level updates into one row, dramatically
 * improving future cold-start load times.
 *
 * If the merged snapshot exceeds this limit, compaction is skipped and
 * updates accumulate as individual rows — each well under 2 MB since
 * individual updates are typically 20–100 bytes (keystrokes) or a few KB
 * (pastes). This is unlikely in practice: a 2 MB Yjs document represents
 * an enormous amount of rich text/structured data. And by the time a
 * document reaches this size, prior cold starts will have already compacted
 * everything up to that point into a single ~2 MB row, so the "tail" of
 * uncompacted updates remains small.
 *
 * If this ever becomes a real issue, `Y.mergeUpdatesV2` is associative —
 * a segmented compaction algorithm could split the update log into multiple
 * sub-2 MB rows. But YAGNI for now.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Durable Object for content documents (`gc: false`).
 *
 * Uses `gc: false` to preserve delete history, enabling lightweight metadata
 * snapshots for version history. `Y.snapshot(doc)` returns a state vector +
 * delete set (~7 bytes to ~1.5 KB) that can reconstruct any past doc state
 * from the retained struct store. Auto-saves a snapshot when the last
 * WebSocket disconnects.
 *
 * Each instance maps to one room ID via `idFromName(roomId)` and hosts a
 * single in-memory `Y.Doc`. Uses the WebSocket Hibernation API so connections
 * stay alive while the DO pays zero compute when idle.
 *
 * ## Worker → DO interface
 *
 * The Hono Worker in `app.ts` calls into this DO via two mechanisms:
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
 * compaction. See {@link MAX_COMPACTED_BYTES} for full details.
 *
 * - **Write path**: Every `Y.Doc` update is appended as a BLOB row via
 *   synchronous `sql.exec` (0 ms — co-located with compute, no network hop).
 *   Each row is a tiny incremental update (~20–100 bytes per keystroke),
 *   well under the 2 MB per-row BLOB limit.
 * - **Cold start**: Reads all rows, merges with `Y.mergeUpdatesV2`, applies
 *   to a fresh `Y.Doc`. When multiple rows exist and the merged blob fits
 *   under {@link MAX_COMPACTED_BYTES}, atomically replaces all rows with a
 *   single merged snapshot. Because `gc: false`, deleted items retain their
 *   full content, so compaction barely reduces total byte size — the win is
 *   row count reduction (1 SQLite read vs thousands on next cold start).
 *   This is free — we already computed `merged` for loading.
 *
 * ### Why DO SQLite over R2 or external storage
 *
 * DO SQLite writes are synchronous and co-located — every keystroke persists
 * in the same event loop tick with zero network latency. R2 would add
 * 5–20 ms per write or require a write buffer that risks data loss on crash.
 * DO SQLite data is replicated to 5 follower machines (3-of-5 quorum) and
 * batched to R2 internally, so durability matches or exceeds standalone R2.
 * Cost is also dramatically lower: DO SQLite row writes are $1/M vs R2's
 * $4.50/M for Class A operations.
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
export class DocumentRoom extends DurableObject {
	private doc!: Y.Doc;
	private awareness!: Awareness;
	private connectionStates = new Map<WebSocket, ConnectionState>();
	/** State vector at time of last auto-save snapshot, used to dedup. */
	private lastAutoSaveSV: Uint8Array | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		// Auto ping/pong without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		// Load the Y.Doc from SQLite synchronously inside blockConcurrencyWhile.
		// This ensures the doc is ready before any fetch() or webSocketMessage() runs.
		const { sql, transactionSync } = ctx.storage;

		this.ctx.blockConcurrencyWhile(async () => {
			sql.exec(`
				CREATE TABLE IF NOT EXISTS updates (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data BLOB NOT NULL,
					created_at TEXT NOT NULL DEFAULT (datetime('now'))
				)
			`);

			sql.exec(`
				CREATE TABLE IF NOT EXISTS snapshots (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					snapshot BLOB NOT NULL,
					label TEXT,
					created_at TEXT NOT NULL DEFAULT (datetime('now'))
				)
			`);

			this.doc = new Y.Doc({ gc: false });
			this.awareness = new Awareness(this.doc);

			const rows = sql.exec('SELECT data FROM updates ORDER BY id').toArray();

			if (rows.length > 0) {
				const merged = Y.mergeUpdatesV2(
					rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
				);
				Y.applyUpdateV2(this.doc, merged);

				if (rows.length > 1 && merged.byteLength <= MAX_COMPACTED_BYTES) {
					transactionSync(() => {
						sql.exec('DELETE FROM updates');
						sql.exec('INSERT INTO updates (data) VALUES (?)', merged);
					});
				}
			}

			this.doc.on('updateV2', (update: Uint8Array) => {
				sql.exec('INSERT INTO updates (data) VALUES (?)', update);
			});

			for (const ws of this.ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as WsAttachment | null;
				if (!attachment) continue;

				const { state } = handleWsOpen(this.doc, this.awareness, ws);
				// Populate the existing set (not replace) so the awareness event
				// handler closure still references the same Set instance.
				for (const id of attachment.controlledClientIds) {
					state.controlledClientIds.add(id);
				}
				this.connectionStates.set(ws, state);
			}
		});
	}

	// --- fetch: WebSocket upgrades only ---

	/**
	 * Only handles WebSocket upgrades. HTTP operations (sync, snapshot) are
	 * exposed as RPC methods called directly on the stub, avoiding the overhead
	 * of constructing/parsing Request/Response objects for binary payloads.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocketUpgrade();
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

	// --- Snapshot RPCs ---

	/** Save a lightweight metadata snapshot of the current doc state. */
	async saveSnapshot(
		label?: string,
	): Promise<{ id: number; createdAt: string }> {
		const snap = Y.snapshot(this.doc);
		const encoded = Y.encodeSnapshot(snap);
		const { sql } = this.ctx.storage;
		const row = sql
			.exec(
				'INSERT INTO snapshots (snapshot, label) VALUES (?, ?) RETURNING id, created_at',
				encoded,
				label ?? null,
			)
			.one();
		return { id: row.id as number, createdAt: row.created_at as string };
	}

	/** List all snapshots (metadata only, no reconstruction). */
	async listSnapshots(): Promise<
		Array<{ id: number; label: string | null; createdAt: string }>
	> {
		const { sql } = this.ctx.storage;
		return sql
			.exec('SELECT id, label, created_at FROM snapshots ORDER BY id DESC')
			.toArray()
			.map((row) => ({
				id: row.id as number,
				label: row.label as string | null,
				createdAt: row.created_at as string,
			}));
	}

	/** Reconstruct a past doc state from a snapshot. Returns full state as binary update. */
	async getSnapshot(snapshotId: number): Promise<Uint8Array | null> {
		const { sql } = this.ctx.storage;
		const rows = sql
			.exec('SELECT snapshot FROM snapshots WHERE id = ?', snapshotId)
			.toArray();
		if (rows.length === 0) return null;

		const snap = Y.decodeSnapshot(
			new Uint8Array(rows[0]!.snapshot as ArrayBuffer),
		);
		const restoredDoc = Y.createDocFromSnapshot(this.doc, snap);
		return Y.encodeStateAsUpdateV2(restoredDoc);
	}

	/**
	 * Merge a past snapshot's content into the current doc.
	 *
	 * This is a CRDT forward-merge, not a destructive rollback. The snapshot's
	 * content is re-applied as a new update, so the doc grows slightly as items
	 * from the snapshot re-enter the struct store. All edits made after the
	 * snapshot are preserved — they coexist with the restored content via CRDT
	 * conflict resolution.
	 *
	 * Saves a "Before restore" safety snapshot before applying.
	 */
	async applySnapshot(snapshotId: number): Promise<boolean> {
		const past = await this.getSnapshot(snapshotId);
		if (!past) return false;

		await this.saveSnapshot('Before restore');
		Y.applyUpdateV2(this.doc, past, 'restore');
		return true;
	}

	// --- WebSocket lifecycle ---

	/**
	 * WebSocket upgrade (Upgrade: websocket).
	 *
	 * Accepts via the Hibernation API (`ctx.acceptWebSocket`) so the DO can
	 * sleep while connections stay alive — zero compute cost when idle.
	 *
	 * On connect: sends SyncStep1 (server's state vector) + current awareness
	 * states. The client responds with SyncStep2 (its missing updates) and the
	 * sync handshake completes. Subsequent mutations flow as incremental
	 * MESSAGE_SYNC updates, broadcast to all peers via {@link webSocketMessage}.
	 *
	 * Per-connection metadata (controlled awareness client IDs) is persisted
	 * via `ws.serializeAttachment` to survive hibernation wake cycles.
	 */
	private async handleWebSocketUpgrade(): Promise<Response> {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		// Accept with Hibernation API — DO can sleep while connection stays alive
		this.ctx.acceptWebSocket(server);

		const { initialMessages, state } = handleWsOpen(
			this.doc,
			this.awareness,
			server,
		);

		this.connectionStates.set(server, state);

		// Persist empty attachment (no controlled client IDs yet)
		server.serializeAttachment({
			controlledClientIds: [],
		} satisfies WsAttachment);

		// Send initial sync messages (SyncStep1 + awareness states)
		for (const msg of initialMessages) {
			server.send(msg);
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		const state = this.connectionStates.get(ws);
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
					safeBroadcast(this.connectionStates, ws, effect.data);
					break;
				case 'persistAttachment':
					ws.serializeAttachment({
						controlledClientIds: [...state.controlledClientIds],
					} satisfies WsAttachment);
					break;
			}
		}
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const state = this.connectionStates.get(ws);
		if (!state) return;

		handleWsClose(state);
		this.connectionStates.delete(ws);

		swallow(() => ws.close(code, reason));

		// Auto-save snapshot when the last client disconnects, if doc changed
		if (this.connectionStates.size === 0) {
			const currentSV = Y.encodeStateVector(this.doc);
			if (
				!this.lastAutoSaveSV ||
				!stateVectorsEqual(currentSV, this.lastAutoSaveSV)
			) {
				this.lastAutoSaveSV = currentSV;
				this.saveSnapshot('Auto-save');
			}
		}
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}
}
