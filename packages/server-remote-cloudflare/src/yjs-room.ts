import { DurableObject } from 'cloudflare:workers';
import {
	Awareness,
	type ConnectionState,
	decodeSyncRequest,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	stateVectorsEqual,
} from '@epicenter/sync-core';
import { Ok, trySync } from 'wellcrafted/result';
import * as Y from 'yjs';

type WsAttachment = {
	controlledClientIds: number[];
};

/** Max incoming WebSocket message size (5 MB). */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/**
 * Max compacted snapshot size (1 MB). DO SQLite has a 2 MB per-row BLOB limit.
 * If a merged snapshot exceeds this, compaction is skipped and updates
 * accumulate as individual rows (each well under the limit).
 */
const MAX_COMPACTED_BYTES = 1 * 1024 * 1024;

/**
 * Durable Object that manages one external collaboration room.
 *
 * Each Durable Object instance maps to one external room ID via
 * `idFromName(roomId)` and hosts a single in-memory `Y.Doc` for that room.
 *
 * Uses the WebSocket Hibernation API so connections stay alive while the DO
 * pays zero compute when idle.
 *
 * ## Storage model
 *
 * Append-only update log in DO SQLite with opportunistic cold-start compaction.
 *
 * - **Write path**: Every `Y.Doc` update is appended as a BLOB row via
 *   synchronous `sql.exec` (0 ms — co-located with compute, no network hop).
 *   Each row is a tiny incremental update (~20–100 bytes per keystroke),
 *   well under the 2 MB per-row BLOB limit.
 * - **Cold start**: Reads all rows, merges with `Y.mergeUpdatesV2`, applies
 *   to a fresh `Y.Doc`. When multiple rows exist and the merged blob fits
 *   under {@link MAX_COMPACTED_BYTES}, atomically replaces all rows with a
 *   single merged snapshot. This collapses redundant insert+delete churn
 *   at zero extra encoding cost (we already merged for loading).
 * - **Compaction guard**: If the merged snapshot exceeds 1 MB, compaction
 *   is skipped and rows accumulate individually — each row stays well under
 *   the 2 MB per-row BLOB limit.
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
 * ## Auth
 *
 * Handled upstream by `authGuard` middleware in app.ts. The Worker validates
 * the session (cookie or `?token=` query param for WebSocket) via Better Auth
 * before forwarding to `stub.fetch()`. The DO itself does not re-validate —
 * it trusts the Worker boundary.
 */
export class YjsRoom extends DurableObject {
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
		this.ctx.blockConcurrencyWhile(async () => {
			const sql = ctx.storage.sql;

			// --- Schema ---
			sql.exec(`
				CREATE TABLE IF NOT EXISTS updates (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data BLOB NOT NULL
				)
			`);

			// --- Load ---
			this.doc = new Y.Doc();
			this.awareness = new Awareness(this.doc);

			const rows = [...sql.exec('SELECT data FROM updates ORDER BY id')];

			if (rows.length > 0) {
				const merged = Y.mergeUpdatesV2(
					rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
				);
				Y.applyUpdateV2(this.doc, merged);

				// Compact: replace N rows with a single merged snapshot.
				// Zero extra cost — we already computed `merged` for loading.
				if (
					rows.length > 1 &&
					merged.byteLength <= MAX_COMPACTED_BYTES
				) {
					ctx.storage.transactionSync(() => {
						sql.exec('DELETE FROM updates');
						sql.exec('INSERT INTO updates (data) VALUES (?)', merged);
					});
				}
			}

			// --- Write-through persistence ---
			this.doc.on('updateV2', (update: Uint8Array) => {
				sql.exec('INSERT INTO updates (data) VALUES (?)', update);
			});

			// On wake from hibernation, restore connection state from attachments.
			for (const ws of this.ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as WsAttachment | null;
				if (!attachment) continue;

				const send = resilientSend(ws);
				const { state } = handleWsOpen(this.doc, this.awareness, ws, send);
				state.controlledClientIds = new Set(attachment.controlledClientIds);
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

		const send = resilientSend(server);
		const { initialMessages, state } = handleWsOpen(
			this.doc,
			this.awareness,
			server,
			send,
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

	// --- Hibernation API callbacks ---

	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		const state = this.connectionStates.get(ws);
		if (!state) return;

		const byteLength =
			message instanceof ArrayBuffer ? message.byteLength : message.length;
		if (byteLength > MAX_MESSAGE_BYTES) {
			ws.close(1009, 'Message too large');
			return;
		}

		const data =
			message instanceof ArrayBuffer
				? new Uint8Array(message)
				: new TextEncoder().encode(message);

		const result = handleWsMessage(data, state);

		if (result.response) {
			ws.send(result.response);
		}

		if (result.broadcast) {
			for (const [otherWs] of this.connectionStates) {
				if (otherWs !== ws) {
					trySync({
						try: () => otherWs.send(result.broadcast!),
						catch: () => Ok(undefined),
					});
				}
			}
		}

		// Persist updated controlledClientIds for hibernation survival
		ws.serializeAttachment({
			controlledClientIds: [...state.controlledClientIds],
		} satisfies WsAttachment);
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

		trySync({
			try: () => ws.close(code, reason),
			catch: () => Ok(undefined),
		});
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}
}

// --- Helpers ---

/** Wrap `ws.send` so failures on dead connections are silently ignored. */
function resilientSend(ws: WebSocket) {
	return (data: Uint8Array) => {
		trySync({
			try: () => ws.send(data),
			catch: () => Ok(undefined),
		});
	};
}

