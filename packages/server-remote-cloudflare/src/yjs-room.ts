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
import * as Y from 'yjs';

type WsAttachment = {
	controlledClientIds: number[];
};

/** Max incoming WebSocket message size (5 MB). */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/** Compact storage every 4 hours while connections are active. */
const COMPACTION_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Durable Object that manages one external collaboration room.
 *
 * Each Durable Object instance maps to one external room ID via
 * `idFromName(roomId)` and hosts a single in-memory `Y.Doc` for that room.
 *
 * Uses the WebSocket Hibernation API so connections stay alive while the DO
 * pays zero compute when idle.
 *
 * Auth: Handled upstream by `authGuard` middleware in app.ts. The Worker
 * validates the session (cookie or `?token=` query param for WebSocket) via
 * Better Auth before forwarding to `stub.fetch()`. The DO itself does not
 * re-validate — it trusts the Worker boundary.
 */
export class YjsRoom extends DurableObject {
	private sql: DurableObjectStorage['sql'];
	private doc!: Y.Doc;
	private awareness!: Awareness;
	private connectionStates: Map<WebSocket, ConnectionState>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.connectionStates = new Map();

		// Auto ping/pong without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		// Load the Y.Doc from SQLite synchronously inside blockConcurrencyWhile.
		// This ensures the doc is ready before any fetch() or webSocketMessage() runs.
		this.ctx.blockConcurrencyWhile(async () => {
			this.initSchema();
			this.doc = this.loadDoc();
			this.awareness = new Awareness(this.doc);

			// On wake from hibernation, restore connection state from attachments.
			for (const ws of this.ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as WsAttachment | null;
				if (!attachment) continue;

				const send = (data: Uint8Array) => {
					try {
						ws.send(data);
					} catch {
						/* disconnected during wake */
					}
				};
				const { state } = handleWsOpen(this.doc, this.awareness, ws, send);
				state.controlledClientIds = new Set(attachment.controlledClientIds);
				this.connectionStates.set(ws, state);
			}
		});
	}

	// --- Storage: direct SQLite, one doc per DO ---

	private initSchema(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS updates (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				data BLOB NOT NULL
			)
		`);
		// Migrate from old schema that had doc_id and created_at columns.
		// DROP COLUMN is safe on DO SQLite (uses modern SQLite ≥ 3.35).
		try { this.sql.exec('ALTER TABLE updates DROP COLUMN doc_id'); } catch { /* already migrated */ }
		try { this.sql.exec('ALTER TABLE updates DROP COLUMN created_at'); } catch { /* already migrated */ }
		this.sql.exec('DROP INDEX IF EXISTS idx_updates_doc_id');
	}

	private loadDoc(): Y.Doc {
		const doc = new Y.Doc();
		const rows = [
			...this.sql.exec('SELECT data FROM updates ORDER BY id'),
		];
		if (rows.length > 0) {
			const merged = Y.mergeUpdatesV2(
				rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
			);
			Y.applyUpdateV2(doc, merged);
		}

		// Persist incremental updates to SQLite.
		// storage.sql.exec is synchronous in DO SQLite, so the callback
		// runs synchronously despite the event system.
		doc.on('updateV2', (update: Uint8Array) => {
			this.sql.exec('INSERT INTO updates (data) VALUES (?)', update);
		});

		return doc;
	}

	private compact(): void {
		const rows = [
			...this.sql.exec('SELECT data FROM updates ORDER BY id'),
		];
		if (rows.length <= 1) return;

		const merged = Y.mergeUpdatesV2(
			rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
		);
		this.ctx.storage.transactionSync(() => {
			this.sql.exec('DELETE FROM updates');
			this.sql.exec('INSERT INTO updates (data) VALUES (?)', merged);
		});
	}

	// --- HTTP handlers: use the live Y.Doc directly ---

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
	 * HTTP sync: decode client state vector + optional update, diff against
	 * the live Y.Doc. Zero storage reads — the doc is always in memory.
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

	/** HTTP snapshot: encode the full doc state from memory. */
	private handleHttpGetDoc(): Response {
		const update = Y.encodeStateAsUpdateV2(this.doc);
		// Empty doc (no meaningful content) returns the same as V2-encoded empty state.
		// A brand-new Y.Doc still produces a valid (small) update, so always return 200.
		return new Response(update, {
			status: 200,
			headers: { 'content-type': 'application/octet-stream' },
		});
	}

	// --- WebSocket upgrade ---

	private handleWebSocketUpgrade(): Response {
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		if (!client || !server) {
			return new Response('Failed to create WebSocket pair', { status: 500 });
		}

		// Accept with Hibernation API — DO can sleep while connection stays alive
		this.ctx.acceptWebSocket(server);

		const send = (data: Uint8Array) => server.send(data);
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
		this.ctx.storage.getAlarm().then((existing) => {
			if (!existing) {
				this.ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
			}
		});

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
					try {
						otherWs.send(result.broadcast);
					} catch {
						/* dead connection */
					}
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

		try {
			ws.close(code, reason);
		} catch {
			/* already closed or errored */
		}
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
