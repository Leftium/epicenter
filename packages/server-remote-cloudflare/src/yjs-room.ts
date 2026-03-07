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
 * Max compacted snapshot size (1.9 MB). DO SQLite has a hard 2 MB BLOB-per-row
 * limit; we leave 100 KB of headroom. For structured data without embedded
 * images this holds ~500K–700K characters. If a doc exceeds this, compaction
 * is skipped and updates accumulate as individual rows (with a warning log).
 */
const MAX_COMPACTED_BYTES = 1.9 * 1024 * 1024;

/** Compact storage every 4 hours while connections are active. */
const COMPACTION_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Compact after this many incremental updates, even if connections remain
 * active. Matches y-websocket's `PREFERRED_TRIM_SIZE` of 500. Prevents
 * unbounded row accumulation during long editing sessions where neither the
 * disconnect trigger nor the 4-hour alarm fires.
 */
const COMPACTION_ROW_THRESHOLD = 500;

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
 * Append-only update log in DO SQLite with periodic compaction:
 *
 * - **Write path**: Every `Y.Doc` update is appended as a BLOB row via
 *   synchronous `sql.exec` (0 ms — co-located with compute, no network hop).
 * - **Compaction**: Replaces all rows with a single full-state snapshot.
 *   Triggered by (1) last client disconnect, (2) 4-hour alarm, or
 *   (3) every {@link COMPACTION_ROW_THRESHOLD} updates during long sessions.
 * - **Cold start**: Reads all rows, merges with `Y.mergeUpdatesV2`, applies
 *   to a fresh `Y.Doc`. After compaction this is a single row; between
 *   compactions it's at most ~500 incremental updates.
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
 * ### 2 MB BLOB ceiling
 *
 * DO SQLite has a 2 MB per-row BLOB limit. Documents exceeding 1.9 MB when
 * compacted cannot be merged into a single row — compaction is skipped with
 * a warning, and updates accumulate as individual rows. For structured data
 * without embedded images (our use case), 1.9 MB holds ~500K–700K characters
 * of text or thousands of structured entries. If logs show compaction being
 * skipped, the upgrade path is SQLite row chunking (no new dependencies) or
 * R2 overflow for the compacted snapshot.
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
	private updatesSinceCompaction = 0;
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

			if (rows.length > 10) {
				console.warn(
					`[YjsRoom] Cold start loading ${rows.length} update rows`,
				);
			}

			if (rows.length > 0) {
				const merged = Y.mergeUpdatesV2(
					rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
				);
				Y.applyUpdateV2(this.doc, merged);
			}

			// --- Write-through persistence ---
			this.doc.on('updateV2', (update: Uint8Array) => {
				sql.exec('INSERT INTO updates (data) VALUES (?)', update);
				this.updatesSinceCompaction++;
				if (this.updatesSinceCompaction >= COMPACTION_ROW_THRESHOLD) {
					this.compact();
				}
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

	/**
	 * Merge accumulated updates into a single snapshot from the live doc.
	 *
	 * Encodes full state via `encodeStateAsUpdateV2` and atomically replaces
	 * all rows. Safe from races because DOs are single-threaded.
	 *
	 * If the snapshot exceeds {@link MAX_COMPACTED_BYTES} (1.9 MB), compaction
	 * is skipped with a warning. The counter resets to avoid re-encoding every
	 * {@link COMPACTION_ROW_THRESHOLD} updates on an oversized doc.
	 */
	private compact(): void {
		const sql = this.ctx.storage.sql;
		const countRows = [...sql.exec('SELECT COUNT(*) as n FROM updates')];
		const rowCount = countRows[0]?.n as number;
		if (rowCount <= 1) return;

		const merged = Y.encodeStateAsUpdateV2(this.doc);
		if (merged.byteLength > MAX_COMPACTED_BYTES) {
			console.warn(
				`[YjsRoom] Doc snapshot is ${(merged.byteLength / 1024 / 1024).toFixed(2)}MB ` +
					`(limit: ${(MAX_COMPACTED_BYTES / 1024 / 1024).toFixed(1)}MB). ` +
					`Compaction skipped. ${rowCount} update rows accumulating.`,
			);
			this.updatesSinceCompaction = 0;
			return;
		}

		this.ctx.storage.transactionSync(() => {
			sql.exec('DELETE FROM updates');
			sql.exec('INSERT INTO updates (data) VALUES (?)', merged);
		});
		this.updatesSinceCompaction = 0;
	}

	// --- Request dispatch ---

	/**
	 * Single entry point for all room requests, forwarded from the Hono Worker
	 * via `stub.fetch(c.req.raw)`. Dispatches on transport/method:
	 *
	 * | Signal               | Handler                       | Purpose                                                       |
	 * |----------------------|-------------------------------|---------------------------------------------------------------|
	 * | `Upgrade: websocket` | {@link handleWebSocketUpgrade} | **Live sync** — persistent connection via Hibernation API.   |
	 * |                      |                               | Receives incremental updates, broadcasts to peers, keeps      |
	 * |                      |                               | awareness in sync. Connection survives DO hibernation.         |
	 * | `POST`               | {@link handleHttpSync}        | **HTTP sync** — client sends state vector + optional update.  |
	 * |                      |                               | Server applies update, diffs against live doc, returns missing |
	 * |                      |                               | changes (or 304 if in sync). Used by HTTP polling provider.   |
	 * | `GET`                | {@link handleHttpGetDoc}      | **Snapshot bootstrap** — full doc state as binary. Used by    |
	 * |                      |                               | WebSocket provider's `snapshotUrl` prefetch to reduce initial  |
	 * |                      |                               | sync payload size.                                            |
	 *
	 * **Why not sync-core's `handleHttpSync`/`handleHttpGetDoc`?**
	 * Those are stateless — they read from an `UpdateLog` and merge on every
	 * request. This DO always has the live `Y.Doc` in memory, so it works
	 * directly with the resident doc. Same semantics, zero I/O overhead.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocketUpgrade();
		}

		if (request.method === 'POST') {
			return this.handleHttpSync(request);
		}

		if (request.method === 'GET') {
			return this.handleHttpGetDoc();
		}

		return new Response('Method not allowed', { status: 405 });
	}

	/**
	 * HTTP sync (POST).
	 *
	 * Binary body format: `[length-prefixed stateVector][length-prefixed update]`
	 * (encoded via `encodeSyncRequest` from sync-core).
	 *
	 * 1. Applies client update to the live doc (triggers `updateV2` → SQLite
	 *    persist + broadcast to WebSocket peers).
	 * 2. Compares state vectors — returns **304** if already in sync.
	 * 3. Otherwise returns **200** with the binary diff the client is missing.
	 */
	private async handleHttpSync(request: Request): Promise<Response> {
		const contentLength = parseInt(
			request.headers.get('content-length') ?? '0',
			10,
		);
		if (contentLength > MAX_MESSAGE_BYTES) {
			return new Response('Payload too large', { status: 413 });
		}

		const body = new Uint8Array(await request.arrayBuffer());
		const { stateVector: clientSV, update } = decodeSyncRequest(body);

		// Apply client's changes to the live doc (triggers updateV2 → persist)
		if (update.byteLength > 0) {
			Y.applyUpdateV2(this.doc, update, 'http');
		}

		const serverSV = Y.encodeStateVector(this.doc);
		if (stateVectorsEqual(serverSV, clientSV)) {
			return new Response(null, { status: 304 });
		}

		const diff = Y.encodeStateAsUpdateV2(this.doc, clientSV);
		return new Response(diff, {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' },
		});
	}

	/**
	 * Snapshot bootstrap (GET).
	 *
	 * Returns the full doc state as `application/octet-stream` via
	 * `Y.encodeStateAsUpdateV2`. Clients apply this with `Y.applyUpdateV2`
	 * to hydrate their local doc before opening a WebSocket, reducing the
	 * amount of data exchanged during the initial sync handshake.
	 */
	private handleHttpGetDoc(): Response {
		const update = Y.encodeStateAsUpdateV2(this.doc);
		return new Response(update, {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' },
		});
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

		// Schedule periodic compaction if no alarm is already set.
		const existing = await this.ctx.storage.getAlarm();
		if (!existing) {
			await this.ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
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

		// Compact storage when last connection leaves.
		// Safe from races: DO is single-threaded, so no new fetch() can run
		// until this handler completes.
		if (this.connectionStates.size === 0) {
			this.compact();
		}

		trySync({
			try: () => ws.close(code, reason),
			catch: () => Ok(undefined),
		});
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}

	/** Periodic compaction: merge accumulated updates into a single snapshot. */
	override async alarm(): Promise<void> {
		this.compact();

		// Reschedule if there are still active connections.
		if (this.ctx.getWebSockets().length > 0) {
			await this.ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
		}
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

