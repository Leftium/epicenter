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
 * Shared Durable Object foundation for Yjs collaboration rooms.
 *
 * Manages a single in-memory `Y.Doc` backed by an append-only SQLite update
 * log with cold-start compaction. Uses the WebSocket Hibernation API so
 * connections stay alive while the DO pays zero compute when idle.
 *
 * Subclasses parameterize the `gc` setting:
 * - {@link WorkspaceRoom}: `gc: true` — small, bounded docs for metadata
 * - {@link DocumentRoom}: `gc: false` — preserves delete history for snapshots
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
 * ## Auth & room isolation
 *
 * Handled upstream by `authGuard` middleware in app.ts. The DO itself does
 * not re-validate — it trusts the Worker boundary.
 */
export class BaseYjsRoom extends DurableObject {
	protected doc!: Y.Doc;
	protected awareness!: Awareness;
	private connectionStates = new Map<WebSocket, ConnectionState>();

	constructor(ctx: DurableObjectState, env: Env, options: { gc: boolean }) {
		super(ctx, env);

		// Auto ping/pong without waking the DO.
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		// Load the Y.Doc from SQLite synchronously inside blockConcurrencyWhile.
		// This ensures the doc is ready before any fetch() or webSocketMessage() runs.
		const { sql, transactionSync } = ctx.storage;

		this.ctx.blockConcurrencyWhile(async () => {
			// --- Schema ---
			sql.exec(`
				CREATE TABLE IF NOT EXISTS updates (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data BLOB NOT NULL
				)
			`);

			this.onInit();

			// --- Load ---
			this.doc = new Y.Doc({ gc: options.gc });
			this.awareness = new Awareness(this.doc);

			const rows = [...sql.exec('SELECT data FROM updates ORDER BY id')];

			if (rows.length > 0) {
				const merged = Y.mergeUpdatesV2(
					rows.map((r) => new Uint8Array(r.data as ArrayBuffer)),
				);
				Y.applyUpdateV2(this.doc, merged);

				// Compact: replace N rows with a single merged snapshot.
				// Zero extra cost — we already computed `merged` for loading.
				if (rows.length > 1 && merged.byteLength <= MAX_COMPACTED_BYTES) {
					transactionSync(() => {
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

				const send = (data: Uint8Array) => swallow(() => ws.send(data));
				const { state } = handleWsOpen(this.doc, this.awareness, ws, send);
				state.controlledClientIds = new Set(attachment.controlledClientIds);
				this.connectionStates.set(ws, state);
			}
		});
	}

	/**
	 * Override to create additional SQLite tables or run setup logic.
	 * Called inside `blockConcurrencyWhile` before the doc is loaded.
	 */
	protected onInit(): void {}

	/**
	 * Override to run logic when the last WebSocket disconnects.
	 * Called after the connection state is cleaned up.
	 */
	protected onLastDisconnect(): void {}

	// --- fetch: WebSocket upgrades only ---

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.handleWebSocketUpgrade();
		}
		return new Response('Method not allowed', { status: 405 });
	}

	// --- RPC methods (called via stub.sync() / stub.getDoc()) ---

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
					swallow(() => otherWs.send(result.broadcast!));
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

		swallow(() => ws.close(code, reason));

		if (this.connectionStates.size === 0) {
			this.onLastDisconnect();
		}
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}
}

// --- Helpers ---

/** Silently ignore errors (e.g. dead WebSocket sends/closes). */
function swallow(fn: () => void): void {
	try {
		fn();
	} catch {
		/* connection already dead */
	}
}
