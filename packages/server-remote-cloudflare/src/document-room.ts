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
 * 2 MB per-row BLOB limit.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/**
 * Durable Object for content documents (`gc: false`).
 *
 * Uses `gc: false` to preserve delete history, enabling lightweight metadata
 * snapshots for version history. `Y.snapshot(doc)` returns a state vector +
 * delete set (~7 bytes to ~1.5 KB) that can reconstruct any past doc state
 * from the retained struct store.
 *
 * Auto-saves a snapshot when the last WebSocket disconnects.
 */
export class DocumentRoom extends DurableObject {
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

			sql.exec(`
				CREATE TABLE IF NOT EXISTS snapshots (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data BLOB NOT NULL,
					label TEXT,
					created_at TEXT NOT NULL DEFAULT (datetime('now'))
				)
			`);

			this.doc = new Y.Doc({ gc: false });
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

	// --- fetch: WebSocket upgrades only ---

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocketUpgrade();
		}
		return new Response('Method not allowed', { status: 405 });
	}

	// --- RPC methods ---

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

	// --- Snapshot RPCs ---

	/** Save a lightweight metadata snapshot of the current doc state. */
	async saveSnapshot(label?: string): Promise<{ id: number; createdAt: string }> {
		const snap = Y.snapshot(this.doc);
		const encoded = Y.encodeSnapshot(snap);
		const { sql } = this.ctx.storage;
		const row = [
			...sql.exec(
				'INSERT INTO snapshots (data, label) VALUES (?, ?) RETURNING id, created_at',
				encoded,
				label ?? null,
			),
		][0]!;
		return { id: row.id as number, createdAt: row.created_at as string };
	}

	/** List all snapshots (metadata only, no reconstruction). */
	async listSnapshots(): Promise<Array<{ id: number; label: string | null; createdAt: string }>> {
		const { sql } = this.ctx.storage;
		return [
			...sql.exec('SELECT id, label, created_at FROM snapshots ORDER BY id DESC'),
		].map((row) => ({
			id: row.id as number,
			label: row.label as string | null,
			createdAt: row.created_at as string,
		}));
	}

	/** Reconstruct a past doc state from a snapshot. Returns full state as binary update. */
	async getSnapshot(snapshotId: number): Promise<Uint8Array | null> {
		const { sql } = this.ctx.storage;
		const rows = [
			...sql.exec('SELECT data FROM snapshots WHERE id = ?', snapshotId),
		];
		if (rows.length === 0) return null;

		const snap = Y.decodeSnapshot(new Uint8Array(rows[0]!.data as ArrayBuffer));
		const restoredDoc = Y.createDocFromSnapshot(this.doc, snap);
		return Y.encodeStateAsUpdateV2(restoredDoc);
	}

	/** Restore a past snapshot's state as the current doc. Saves a "Before restore" snapshot first. */
	async restoreSnapshot(snapshotId: number): Promise<boolean> {
		const past = await this.getSnapshot(snapshotId);
		if (!past) return false;

		await this.saveSnapshot('Before restore');
		Y.applyUpdateV2(this.doc, past, 'restore');
		return true;
	}

	// --- WebSocket lifecycle ---

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

		// Auto-save snapshot when the last client disconnects
		if (this.connectionStates.size === 0) {
			this.saveSnapshot('Auto-save');
		}
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
