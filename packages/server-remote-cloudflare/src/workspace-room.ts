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
 * Durable Object for workspace metadata documents (`gc: true`).
 *
 * Workspace docs hold structured metadata (tables, KV, awareness) and don't
 * need version history. GC keeps docs small by discarding deleted item
 * structures.
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
 *   single merged snapshot. Because `gc: true`, deleted items are replaced
 *   by lightweight GC structs (~8 bytes each), so compaction genuinely
 *   reduces both row count AND total byte size. This is free — we already
 *   computed `merged` for loading.
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
export class WorkspaceRoom extends DurableObject {
	private doc!: Y.Doc;
	private awareness!: Awareness;
	private connectionStates = new Map<WebSocket, ConnectionState>();

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
					data BLOB NOT NULL
				)
			`);

			this.doc = new Y.Doc();
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

		const { data: result, error } = handleWsMessage(data, state);
		if (error) {
			console.error(error.message);
			return;
		}

		if (result.response) {
			ws.send(result.response);
		}

		if (result.broadcast) {
			const msg = result.broadcast;
			for (const [otherWs] of this.connectionStates) {
				if (otherWs !== ws && otherWs.readyState === WebSocket.OPEN) {
					otherWs.send(msg);
				}
			}
		}

		// Only persist when awareness client IDs actually changed
		if (result.awarenessChanged) {
			ws.serializeAttachment({
				controlledClientIds: [...state.controlledClientIds],
			} satisfies WsAttachment);
		}
	}

	// --- Hibernation API callbacks ---

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
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}
}

/** Silently ignore errors (e.g. dead WebSocket sends/closes). */
function swallow(fn: () => void): void {
	try {
		fn();
	} catch {
		/* connection already dead */
	}
}
