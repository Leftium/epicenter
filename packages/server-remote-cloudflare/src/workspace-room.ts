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

/**
 * Max compacted snapshot size (2 MB). Cloudflare DO SQLite enforces a hard
 * 2 MB per-row BLOB limit. See {@link DocumentRoom} for the same constant
 * with identical semantics.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Durable Object for workspace metadata documents (`gc: true`).
 *
 * Workspace docs hold structured metadata (tables, KV, awareness) and don't
 * need version history. GC keeps docs small by discarding deleted item
 * structures.
 *
 * Uses the WebSocket Hibernation API so connections stay alive while the DO
 * pays zero compute when idle. Storage is an append-only SQLite update log
 * with opportunistic cold-start compaction.
 */
export class WorkspaceRoom extends DurableObject {
	private doc!: Y.Doc;
	private awareness!: Awareness;
	private connectionStates = new Map<WebSocket, ConnectionState>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

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

			const rows = [...sql.exec('SELECT data FROM updates ORDER BY id')];

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

				const send = (data: Uint8Array) => swallow(() => ws.send(data));
				const { state } = handleWsOpen(this.doc, this.awareness, ws, send);
				state.controlledClientIds = new Set(attachment.controlledClientIds);
				this.connectionStates.set(ws, state);
			}
		});
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocketUpgrade();
		}
		return new Response('Method not allowed', { status: 405 });
	}

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

	async getDoc(): Promise<Uint8Array> {
		return Y.encodeStateAsUpdateV2(this.doc);
	}

	private async handleWebSocketUpgrade(): Promise<Response> {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);

		const send = (data: Uint8Array) => swallow(() => server.send(data));
		const { initialMessages, state } = handleWsOpen(
			this.doc,
			this.awareness,
			server,
			send,
		);

		this.connectionStates.set(server, state);

		server.serializeAttachment({
			controlledClientIds: [],
		} satisfies WsAttachment);

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
					swallow(() => otherWs.send(result.broadcast!));
				}
			}
		}

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
