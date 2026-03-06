import { DurableObject } from 'cloudflare:workers';
import {
	compactUpdateLog,
	type ConnectionState,
	createRoomManager,
	handleHttpGetDoc,
	handleHttpSync,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
	type UpdateLog,
} from '@epicenter/sync-core';
import * as Y from 'yjs';


type WsAttachment = {
	controlledClientIds: number[];
};

/**
 * Durable Object that manages a single Y.Doc sync room.
 *
 * Uses the WebSocket Hibernation API so connections stay alive while the DO
 * pays zero compute when idle. One DO instance per room ID via `idFromName(roomId)`.
 */
/** Max incoming WebSocket message size (5 MB). */
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;

/** Compact storage every 4 hours while connections are active. */
const COMPACTION_INTERVAL_MS = 4 * 60 * 60 * 1000;

export class YjsRoom extends DurableObject {
	private storage: UpdateLog;
	private roomManager!: ReturnType<typeof createRoomManager>;
	private connectionStates: Map<WebSocket, ConnectionState>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.storage = createDoSqliteUpdateLog(ctx.storage);
		this.connectionStates = new Map();

		// Auto ping/pong without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		// Load the Y.Doc from SQLite and initialize the RoomManager synchronously
		// inside blockConcurrencyWhile. This ensures the doc is ready before any
		// fetch() or webSocketMessage() runs.
		this.ctx.blockConcurrencyWhile(async () => {
			const doc = await this.loadOrCreateDoc('room');

			this.roomManager = createRoomManager({
				getDoc: () => doc,
			});

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
				const result = handleWsOpen(this.roomManager, 'room', ws, send);
				if (result.ok) {
					result.state.controlledClientIds = new Set(
						attachment.controlledClientIds,
					);
					result.state.doc.on('update', result.state.updateHandler);
					this.connectionStates.set(ws, result.state);
				}
			}
		});
	}

	private async loadOrCreateDoc(roomId: string): Promise<Y.Doc> {
		const doc = new Y.Doc();
		const updates = await this.storage.readAll(roomId);
		if (updates.length > 0) {
			// Storage uses V2 format for better compression, while the wire
			// protocol (y-protocols) uses V1. This is safe because Yjs fires
			// both `update` and `updateV2` events regardless of input format.
			const merged = Y.mergeUpdatesV2(updates);
			Y.applyUpdateV2(doc, merged);
		}

		// Persist incremental updates to SQLite.
		// Note: storage.sql.exec is synchronous in DO SQLite, so the callback
		// runs synchronously despite the event system.
		doc.on('updateV2', (update: Uint8Array) => {
			this.storage.append(roomId, update);
		});

		return doc;
	}

	// --- WebSocket upgrade (called from worker via stub.fetch) ---

	override async fetch(request: Request): Promise<Response> {
		// WebSocket upgrade
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocketUpgrade();
		}

		// HTTP sync: POST
		if (request.method === 'POST') {
			const contentLength = parseInt(
				request.headers.get('content-length') ?? '0',
			);
			if (contentLength > MAX_MESSAGE_BYTES) {
				return new Response('Payload too large', { status: 413 });
			}
			const body = new Uint8Array(await request.arrayBuffer());
			const result = await handleHttpSync(this.storage, 'room', body);
			if (!result.body) return new Response(null, { status: result.status });
			return new Response(result.body, {
				status: result.status,
				headers: { 'content-type': 'application/octet-stream' },
			});
		}

		// HTTP sync: GET (document snapshot)
		if (request.method === 'GET') {
			const result = await handleHttpGetDoc(this.storage, 'room');
			if (!result.body) return new Response(null, { status: 404 });
			return new Response(result.body, {
				status: 200,
				headers: { 'content-type': 'application/octet-stream' },
			});
		}

		return new Response('Method not allowed', { status: 405 });
	}

	private handleWebSocketUpgrade(): Response {
		const pair = new WebSocketPair();
		const client = pair[0]!;
		const server = pair[1]!;

		// Accept with Hibernation API — DO can sleep while connection stays alive
		this.ctx.acceptWebSocket(server);

		const send = (data: Uint8Array) => server.send(data);
		const result = handleWsOpen(this.roomManager, 'room', server, send);

		if (!result.ok) {
			server.close(result.closeCode, result.closeReason);
			return new Response(null, { status: 400 });
		}

		// Wire doc update broadcaster
		result.state.doc.on('update', result.state.updateHandler);
		this.connectionStates.set(server, result.state);

		// Persist empty attachment (no controlled client IDs yet)
		server.serializeAttachment({
			controlledClientIds: [],
		} satisfies WsAttachment);

		// Send initial sync messages (SyncStep1 + awareness states)
		for (const msg of result.initialMessages) {
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

		handleWsClose(state, this.roomManager);
		this.connectionStates.delete(ws);

		// Compact storage when last connection leaves.
		// Safe from races: DO is single-threaded, so no new fetch() can run
		// until this handler completes.
		if (this.connectionStates.size === 0) {
			await compactUpdateLog(this.storage, 'room');
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
		await compactUpdateLog(this.storage, 'room');

		// Reschedule if there are still active connections.
		if (this.ctx.getWebSockets().length > 0) {
			await this.ctx.storage.setAlarm(Date.now() + COMPACTION_INTERVAL_MS);
		}
	}
}

/**
 * Create an UpdateLog backed by Durable Object SQLite.
 *
 * Uses the DO's built-in SQLite database for persistent Y.Doc update storage.
 * SQLite in Durable Objects is GA with 10GB per DO.
 */
function createDoSqliteUpdateLog(
	storage: DurableObjectStorage,
): UpdateLog {
	let initialized = false;

	function ensureTable() {
		if (initialized) return;
		storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS updates (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				doc_id TEXT NOT NULL,
				data BLOB NOT NULL,
				created_at INTEGER DEFAULT (unixepoch())
			)
		`);
		initialized = true;
	}

	return {
		append(docId, update) {
			ensureTable();
			storage.sql.exec(
				'INSERT INTO updates (doc_id, data) VALUES (?, ?)',
				docId,
				update,
			);
		},

		readAll(docId) {
			ensureTable();
			const cursor = storage.sql.exec(
				'SELECT data FROM updates WHERE doc_id = ? ORDER BY id',
				docId,
			);
			return [...cursor].map(
				(row) => new Uint8Array(row.data as ArrayBuffer),
			);
		},

		replaceAll(docId, mergedUpdate) {
			ensureTable();
			storage.transactionSync(() => {
				storage.sql.exec('DELETE FROM updates WHERE doc_id = ?', docId);
				storage.sql.exec(
					'INSERT INTO updates (doc_id, data) VALUES (?, ?)',
					docId,
					mergedUpdate,
				);
			});
		},
	};
}
