import { DurableObject } from 'cloudflare:workers';
import {
	type ConnectionState,
	createRoomManager,
	handleHttpGetDoc,
	handleHttpSync,
	handleWsClose,
	handleWsMessage,
	handleWsOpen,
} from '@epicenter/sync-core';
import * as Y from 'yjs';
import { DOSqliteSyncStorage } from './storage';

type WsAttachment = {
	controlledClientIds: number[];
};

/**
 * Durable Object that manages a single Y.Doc sync room.
 *
 * Uses the WebSocket Hibernation API so connections stay alive while the DO
 * pays zero compute when idle. One DO instance per room ID via `idFromName(roomId)`.
 */
export class YjsRoom extends DurableObject {
	private storage: DOSqliteSyncStorage;
	private roomManager!: ReturnType<typeof createRoomManager>;
	private connectionStates: Map<WebSocket, ConnectionState>;

	constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
		super(ctx, env);
		this.storage = new DOSqliteSyncStorage(ctx.storage);
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
		const updates = await this.storage.getAllUpdates(roomId);
		if (updates.length > 0) {
			const merged = Y.mergeUpdatesV2(updates);
			Y.applyUpdateV2(doc, merged);
		}

		// Persist incremental updates to SQLite.
		doc.on('updateV2', async (update: Uint8Array) => {
			await this.storage.appendUpdate(roomId, update);
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

		return new Response(null, { status: 101, webSocket: client });
	}

	// --- Hibernation API callbacks ---

	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		const state = this.connectionStates.get(ws);
		if (!state) return;

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
		if (this.connectionStates.size === 0) {
			await this.storage.compactAll('room');
		}

		ws.close(code, reason);
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}
}
