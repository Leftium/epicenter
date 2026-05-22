/**
 * Self-contained Yjs sync + dispatch room for Cloudflare Durable Objects.
 *
 * Everything a room needs lives in this file: SQLite update log persistence,
 * WebSocket lifecycle, server-owned presence, dispatch correlation, and the
 * `Room` class itself.
 *
 * ## Module structure
 *
 * {@link Room}: the Durable Object class wiring persistence, sync, presence,
 *   and dispatch together.
 *
 * ## Wire surfaces
 *
 * Three surfaces share auth context but are independent at the wire level:
 *
 *   binary WS frames  -> standard y-protocols SYNC.
 *   text WS frames    -> dispatch push/response (`dispatch_inbound`,
 *                        `dispatch_response`) and the server-owned
 *                        presence channel (`presence`).
 *   RPC method        -> {@link Room.dispatch}: the Worker forwards
 *                        a route-level `/dispatch` request here. The DO mints
 *                        a correlation id, pushes `dispatch_inbound` to
 *                        the recipient's socket, and resolves the RPC
 *                        promise when the recipient's `dispatch_response`
 *                        arrives.
 *
 * ## Presence
 *
 * Presence is server-owned: the `connections` map is the source of truth.
 * On every connection change the DO broadcasts one `presence` text frame
 * carrying the FULL install list (computed per-recipient, self excluded),
 * so clients store `devices.list()` verbatim with no delta reassembly.
 * There is no Awareness instance on the relay; the y-protocols Awareness
 * slot is reserved for future cursor/typing/selection work, not liveness.
 */

import { DurableObject } from 'cloudflare:workers';
import {
	decodeSyncRequest,
	encodeSyncStep1,
	encodeSyncUpdate,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	stateVectorsEqual,
} from '@epicenter/sync';
import type {
	DispatchErrorWire,
	DispatchInboundFrame,
} from '@epicenter/workspace/document/dispatch-protocol';
import type { PresenceFrame } from '@epicenter/workspace/document/presence';
import { Err, type Result } from 'wellcrafted/result';
import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from './constants';
import { applyMessage } from './sync-handlers';

// ============================================================================
// Dispatch RPC types
// ============================================================================

/**
 * Worker -> DO RPC argument for {@link Room.dispatch}. The text-frame wire
 * type ({@link DispatchInboundFrame}) and the error vocabulary
 * ({@link DispatchErrorWire}) live in
 * `@epicenter/workspace/document/dispatch-protocol`, shared with the client.
 */
export type DispatchRpcRequest = {
	to: string;
	action: string;
	input?: unknown;
};

// ============================================================================
// Constants
// ============================================================================

/**
 * Max compacted update size (2 MB). Cloudflare DO SQLite enforces a hard
 * 2 MB per-row BLOB limit.
 */
const MAX_COMPACTED_BYTES = 2 * 1024 * 1024;

/** Delay before alarm-based compaction fires (30 seconds). */
const COMPACTION_DELAY_MS = 30_000;

/**
 * Grace window before the debounced presence rebroadcast fires after the
 * last socket for an install closes.
 *
 * A graceful tab handoff (T1 closes, T2 connects within a few hundred ms)
 * would otherwise broadcast the install as gone and then back, even though
 * it was continuously present from the user's perspective. The debounce
 * lets a reconnecting socket supersede the pending rebroadcast before peers
 * ever see the flap.
 *
 * Close-code policy: WebSocket close code 4401 (permanent auth failure)
 * bypasses the debounce and rebroadcasts immediately. There is no
 * legitimate handoff for an auth-failed socket, and forcing peers to wait
 * 300 ms to learn an install is permanently offline yields no benefit. All
 * other close codes (1000, 1006, 1009, 1011, 4400, ...) respect the window.
 *
 * 300 ms is a starting point. See the spec's "Grace-window justification"
 * section for the rationale.
 */
const PRESENCE_REBROADCAST_GRACE_MS = 300;

/**
 * Internal cap on how long the DO holds an in-flight dispatch open before
 * giving up on the recipient. The HTTP request's lifetime is the actual
 * deadline (the caller's `AbortSignal` or fetch timeout); this is a safety
 * net so the pending map cannot grow unbounded if both the recipient and
 * the caller misbehave.
 *
 * Set well under Cloudflare Workers' HTTP request timeout (~100s) so the
 * `RecipientOffline` response always rides the original request.
 */
const DISPATCH_INTERNAL_TIMEOUT_MS = 60_000;

/**
 * Per-connection metadata persisted via `ws.serializeAttachment` to survive
 * hibernation.
 *
 * - `installationId`: URL-stamped at upgrade, the address used by dispatch
 *   and the only identity the relay carries for a socket.
 */
type WsAttachment = {
	installationId: string;
};

// ============================================================================
// Room
// ============================================================================

/**
 * Yjs sync + dispatch room backed by a Cloudflare Durable Object.
 *
 * Owns: SQLite update log persistence, WebSocket lifecycle via the
 * Hibernation API, HTTP sync via RPC, dispatch correlation, and the
 * server-owned presence channel. Every room runs with `gc: true`.
 *
 * ## Worker to DO interface
 *
 * **RPC** (`stub.sync()`, `stub.getDoc()`, `stub.dispatch()`): for HTTP
 *   sync, snapshot bootstrap, and route-level dispatch endpoints. Direct
 *   method calls avoid Request/Response serialization overhead for binary
 *   payloads.
 * **fetch** (`stub.fetch(request)`): for WebSocket upgrades only, since
 *   the 101 Switching Protocols handshake requires HTTP request/response
 *   semantics.
 *
 * ## Storage model
 *
 * Append-only update log in DO SQLite with opportunistic cold-start
 * compaction. Initialized inside `blockConcurrencyWhile` in the constructor.
 *
 * ## Auth & data isolation
 *
 * Handled upstream by Hono routes in app.ts. The Worker validates the caller,
 * checks any route-owned policy, and constructs the internal DO name before
 * calling RPC methods or forwarding fetch. The DO itself does not re-validate.
 *
 * DO names are host-owned opaque strings, built by app.ts as
 * `subject:{user.id}:rooms:{room}`.
 */
export class Room extends DurableObject {
	/**
	 * The shared Yjs document for this room.
	 *
	 * Initialized inside `ctx.blockConcurrencyWhile()` in the constructor.
	 * The definite assignment assertion (`!`) is safe because of two
	 * guarantees working together:
	 *
	 * 1. **Cloudflare runtime guarantee**: `blockConcurrencyWhile` prevents
	 *    the DO from receiving any incoming requests until the
	 *    initialization promise resolves.
	 * 2. **Synchronous async callback**: The callback passed to
	 *    `blockConcurrencyWhile` contains no `await`, so it executes to
	 *    completion synchronously.
	 *
	 * If an `await` is ever added to the `blockConcurrencyWhile` callback,
	 * guarantee (2) breaks.
	 *
	 * @see {@link https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile | blockConcurrencyWhile docs}
	 */
	private doc!: Y.Doc;

	/** Open WebSocket connections, each mapped to its URL-stamped installationId. */
	private connections = new Map<WebSocket, string>();

	/**
	 * Pending debounced presence rebroadcast, or `null` if none is armed.
	 * Armed when the last socket for an install closes; cleared by the timer
	 * firing (real disconnect) or by a connect superseding it (handoff).
	 *
	 * A single shared timer suffices because the rebroadcast reads the live
	 * connection list at fire time, so a burst of departures collapses into
	 * one frame.
	 */
	private pendingRebroadcast: ReturnType<typeof setTimeout> | null = null;

	/**
	 * @see {@link PRESENCE_REBROADCAST_GRACE_MS}
	 */
	private static readonly PRESENCE_REBROADCAST_GRACE_MS =
		PRESENCE_REBROADCAST_GRACE_MS;

	/**
	 * WebSocket close code emitted by the auth layer when the connection's
	 * credentials are permanently invalid. Bypasses the presence grace
	 * window: peers see the install drop immediately instead of waiting
	 * 300 ms for a handoff that cannot happen.
	 */
	private static readonly CLOSE_CODE_AUTH_FAILED = 4401;

	/**
	 * In-flight dispatches awaiting `dispatch_response`. Keyed by the
	 * server-minted correlation id. Each entry captures the recipient
	 * socket (for "did this close mid-flight?" cleanup) and a `resolve`
	 * that completes the awaiting RPC promise. `resolve`'s closure also
	 * clears the safety timeout, so the rest of the DO never has to
	 * touch the timer directly.
	 */
	private pendingDispatches = new Map<
		string,
		{
			recipientWs: WebSocket;
			resolve: (result: Result<unknown, unknown>) => void;
		}
	>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair('ping', 'pong'),
		);

		ctx.blockConcurrencyWhile(async () => {
			this.doc = new Y.Doc({ gc: true });

			// --- Update log: DDL + cold-start load + compaction + live persist ---

			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS updates (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					data BLOB NOT NULL
				)
			`);

			const rows = ctx.storage.sql
				.exec('SELECT data FROM updates ORDER BY id')
				.toArray();

			for (const row of rows) {
				Y.applyUpdateV2(this.doc, new Uint8Array(row.data as ArrayBuffer));
			}
			compactUpdateLog(ctx, this.doc);

			this.doc.on('updateV2', (update: Uint8Array) => {
				ctx.storage.sql.exec('INSERT INTO updates (data) VALUES (?)', update);
			});

			// Fan every doc update out to all connected sockets except the
			// one that originated it. A single room-level listener replaces
			// the old per-connection listeners: the frame is encoded once,
			// and `connections` is read at fire time so it always reflects
			// the live socket set.
			this.doc.on('updateV2', (update: Uint8Array, origin: unknown) => {
				const frame = encodeSyncUpdate({ update });
				for (const ws of this.connections.keys()) {
					if (ws === origin) continue;
					try {
						ws.send(frame);
					} catch {
						/* socket already dead; its close event runs cleanup */
					}
				}
			});

			// --- Restore connections that survived hibernation ---
			// Iterates ctx.getWebSockets() and records each socket's
			// URL-stamped installationId.
			//
			// Presence is rebuilt implicitly: the connections Map is the
			// source of truth, so once these entries are restored,
			// `snapshotInstalls()` and `pickRecipient()` return correct
			// results immediately. No broadcast, no clock seeding, no
			// force-clear; any subsequent upgrade or close drives the next
			// presence delta the same way it would on a never-hibernated DO.
			for (const ws of ctx.getWebSockets()) {
				const attachment = ws.deserializeAttachment() as WsAttachment | null;
				if (!attachment) continue;
				this.connections.set(ws, attachment.installationId);
			}
		});
	}

	// --- fetch: WebSocket upgrades only ---

	/**
	 * Only handles WebSocket upgrades. HTTP sync operations are exposed
	 * as RPC methods called directly on the stub, avoiding the overhead
	 * of constructing/parsing Request/Response objects for binary payloads.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			return this.upgrade(request);
		}
		return new Response('Method not allowed', { status: 405 });
	}

	/**
	 * Accept a WebSocket upgrade via the Hibernation API.
	 *
	 * Creates a `WebSocketPair`, registers the server side with the Cloudflare
	 * runtime for hibernation, stashes the URL-stamped `installationId` in
	 * the attachment, runs the initial Yjs sync handshake (SyncStep1), and
	 * returns the 101 Switching Protocols response.
	 *
	 * The `installationId` query parameter is required: it is the address
	 * used by `dispatch({ to })` and the value the relay stamps on the
	 * socket attachment for the lifetime of the connection. No round-trip
	 * validation: the URL stamp is the binding.
	 *
	 * Cancels any pending compaction alarm: a new client just connected, so
	 * compacting now would be wasteful.
	 *
	 * The client offers `sec-websocket-protocol: <MAIN_SUBPROTOCOL>, bearer.<token>`;
	 * we echo only the main subprotocol to complete the handshake.
	 */
	private upgrade(request: Request): Response {
		const url = new URL(request.url);
		const installationId = url.searchParams.get('installationId');
		if (!installationId) {
			return new Response('missing installationId', { status: 400 });
		}

		void this.ctx.storage.deleteAlarm();

		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];

		this.ctx.acceptWebSocket(server);

		server.serializeAttachment({ installationId } satisfies WsAttachment);

		this.connections.set(server, installationId);

		server.send(encodeSyncStep1({ doc: this.doc }));

		// Presence: send the full install list to the new socket. If this is
		// the FIRST socket for `installationId`, room membership changed, so
		// rebroadcast the live list to every other socket; subsequent tabs of
		// the same install leave the list unchanged and need no rebroadcast.
		// A connect supersedes any pending debounced rebroadcast.
		server.send(
			JSON.stringify({
				type: 'presence',
				installs: this.snapshotInstalls(server),
			} satisfies PresenceFrame),
		);

		if (this.countInstallSockets(installationId) === 1) {
			this.cancelPendingRebroadcast();
			this.broadcastPresence(server);
		}

		const responseHeaders = new Headers();
		const offered = parseSubprotocols(
			request.headers.get('sec-websocket-protocol'),
		);
		if (offered.includes(MAIN_SUBPROTOCOL)) {
			responseHeaders.set('sec-websocket-protocol', MAIN_SUBPROTOCOL);
		}

		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: responseHeaders,
		});
	}

	// --- RPC methods (called via stub.sync() / stub.getDoc() / stub.dispatch()) ---

	/**
	 * HTTP sync via RPC.
	 *
	 * Binary body format: `[length-prefixed stateVector][length-prefixed update]`
	 * (encoded via `encodeSyncRequest` from `@epicenter/sync`).
	 *
	 * Applies the client update to the live doc and returns the binary
	 * diff the client is missing, or `null` if already in sync.
	 */
	async sync(body: Uint8Array): Promise<{
		diff: Uint8Array | null;
		storageBytes: number;
	}> {
		const { stateVector: clientSV, update } = decodeSyncRequest(body);

		if (update.byteLength > 0) {
			Y.applyUpdateV2(this.doc, update, 'http');
		}

		const serverSV = Y.encodeStateVector(this.doc);
		const diff = stateVectorsEqual(serverSV, clientSV)
			? null
			: Y.encodeStateAsUpdateV2(this.doc, clientSV);

		return {
			diff,
			storageBytes: this.ctx.storage.sql.databaseSize,
		};
	}

	/**
	 * Snapshot bootstrap via RPC.
	 *
	 * Returns the full doc state via `Y.encodeStateAsUpdateV2`. Clients
	 * apply this with `Y.applyUpdateV2` to hydrate their local doc before
	 * opening a WebSocket, reducing the initial sync payload size.
	 */
	async getDoc(): Promise<{ data: Uint8Array; storageBytes: number }> {
		return {
			data: Y.encodeStateAsUpdateV2(this.doc),
			storageBytes: this.ctx.storage.sql.databaseSize,
		};
	}

	/** Delete all storage for this DO. Used for cleanup of renamed/orphaned rooms. */
	async deleteStorage(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	/**
	 * Dispatch RPC: route an HTTP dispatch body to a
	 * live recipient socket, await its response, and return the result.
	 *
	 * Picks the most-recently-connected socket for `to`. On miss returns
	 * `RecipientOffline` immediately. Otherwise mints a correlation id,
	 * pushes `dispatch_inbound` to the recipient, and resolves the
	 * Promise either:
	 *   - on matching `dispatch_response`,
	 *   - on the recipient socket closing (the relay observes the close
	 *     and resolves pending entries with `RecipientOffline`),
	 *   - on the internal safety-net timeout firing (`RecipientOffline`).
	 *
	 * The caller's HTTP request lifetime is the *real* deadline. If the
	 * caller aborts, the DO's Promise resolution is discarded by the
	 * Worker; the internal timeout cleans up the pending entry.
	 */
	async dispatch(req: DispatchRpcRequest): Promise<Result<unknown, unknown>> {
		const recipientWs = this.pickRecipient(req.to);
		if (!recipientWs) {
			return recipientOffline(req.to);
		}

		const id = crypto.randomUUID();
		const frame: DispatchInboundFrame = {
			type: 'dispatch_inbound',
			id,
			action: req.action,
			input: req.input,
		};

		return new Promise<Result<unknown, unknown>>((resolve) => {
			const timeoutHandle = setTimeout(() => {
				if (!this.pendingDispatches.has(id)) return;
				this.pendingDispatches.delete(id);
				resolve(recipientOffline(req.to));
			}, DISPATCH_INTERNAL_TIMEOUT_MS);

			this.pendingDispatches.set(id, {
				recipientWs,
				resolve: (result) => {
					clearTimeout(timeoutHandle);
					resolve(result);
				},
			});

			try {
				recipientWs.send(JSON.stringify(frame));
			} catch {
				// Socket died between pickRecipient and send. Route through the
				// pending entry's `resolve` so the safety timeout is cleared.
				const pending = this.pendingDispatches.get(id);
				if (pending) {
					this.pendingDispatches.delete(id);
					pending.resolve(recipientOffline(req.to));
				}
			}
		});
	}

	// --- Presence helpers ---

	/**
	 * Snapshot of currently-connected `installationId`s, deduped (multi-tab
	 * same-install collapses to one entry). Pass `exclude` to omit the
	 * caller's own socket; if the caller's installationId still has other
	 * open sockets, those siblings are excluded too. The result is "remote
	 * installs" from the perspective of the receiver.
	 */
	private snapshotInstalls(exclude?: WebSocket): string[] {
		const excludeInstall = exclude
			? this.connections.get(exclude)
			: undefined;
		const seen = new Set<string>();
		for (const [ws, installationId] of this.connections) {
			if (ws === exclude) continue;
			if (excludeInstall && installationId === excludeInstall) {
				continue;
			}
			seen.add(installationId);
		}
		return Array.from(seen).sort();
	}

	/**
	 * Count the number of OPEN sockets currently associated with
	 * `installationId`. Used to detect the first socket for an install (on
	 * connect) and the last socket (on close), the two events that change
	 * room membership and therefore trigger a presence rebroadcast.
	 */
	private countInstallSockets(installationId: string): number {
		let count = 0;
		for (const [, id] of this.connections) {
			if (id === installationId) count++;
		}
		return count;
	}

	/**
	 * Push the current presence list to every open socket, optionally
	 * skipping `exclude` (a freshly-upgraded socket that was already sent
	 * its list directly). Each socket receives its own install excluded, so
	 * the frame is that receiver's "remote installs" view. A wedged socket's
	 * `send` is swallowed; its close event runs the full cleanup path.
	 */
	private broadcastPresence(exclude?: WebSocket): void {
		for (const [peer] of this.connections) {
			if (peer === exclude) continue;
			if (peer.readyState !== WebSocket.OPEN) continue;
			try {
				peer.send(
					JSON.stringify({
						type: 'presence',
						installs: this.snapshotInstalls(peer),
					} satisfies PresenceFrame),
				);
			} catch {
				/* peer's close event will run the full cleanup path */
			}
		}
	}

	/**
	 * Arm the debounced presence rebroadcast after the grace window. Called
	 * when the last socket for an install closes. A single shared timer: if
	 * one is already pending, leave it, so a burst of departures is
	 * announced at most one grace window after the FIRST departure. When it
	 * fires it broadcasts the then-current full list, reflecting every
	 * departure (and any reconnect) that happened during the window.
	 */
	private schedulePresenceRebroadcast(): void {
		if (this.pendingRebroadcast) return;
		this.pendingRebroadcast = setTimeout(() => {
			this.pendingRebroadcast = null;
			this.broadcastPresence();
		}, Room.PRESENCE_REBROADCAST_GRACE_MS);
	}

	/**
	 * Cancel a pending debounced rebroadcast. Called on connect: the connect
	 * path broadcasts the live list immediately, which supersedes whatever
	 * the debounced timer would have sent. A graceful tab handoff lands here
	 * (T1 closes and arms the timer, T2 connects and cancels it), so peers
	 * never observe the install leave.
	 */
	private cancelPendingRebroadcast(): void {
		if (!this.pendingRebroadcast) return;
		clearTimeout(this.pendingRebroadcast);
		this.pendingRebroadcast = null;
	}

	/**
	 * Resolve a recipient `installationId` to the most-recently-connected
	 * open socket, if any. Iteration order in `Map` is insertion order, so
	 * the *last* match in a forward scan is the newest.
	 */
	private pickRecipient(installationId: string): WebSocket | null {
		let newest: WebSocket | null = null;
		for (const [ws, id] of this.connections) {
			if (id === installationId && ws.readyState === WebSocket.OPEN) {
				newest = ws;
			}
		}
		return newest;
	}

	// --- WebSocket lifecycle ---

	/**
	 * Handle an incoming WebSocket message.
	 *
	 * Routes on the message envelope:
	 *   - text frames: dispatch_response correlation.
	 *   - binary frames: standard y-protocols SYNC.
	 */
	override async webSocketMessage(
		ws: WebSocket,
		message: ArrayBuffer | string,
	): Promise<void> {
		const installationId = this.connections.get(ws);
		if (installationId === undefined) return;

		const byteLength =
			message instanceof ArrayBuffer ? message.byteLength : message.length;
		if (byteLength > MAX_PAYLOAD_BYTES) {
			ws.close(1009, 'Message too large');
			return;
		}

		if (typeof message === 'string') {
			this.handleTextFrame(ws, installationId, message);
			return;
		}

		const { data: reply, error } = applyMessage({
			data: new Uint8Array(message),
			doc: this.doc,
			ws,
		});
		if (error) {
			console.error(error.message);
			return;
		}
		if (reply) ws.send(reply);
	}

	/**
	 * Handle a recipient -> server text frame. Today the only valid type
	 * is `dispatch_response`; anything else closes the socket with
	 * `4400 protocol-error`.
	 */
	private handleTextFrame(
		ws: WebSocket,
		installationId: string,
		message: string,
	): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(message);
		} catch {
			ws.close(4400, 'protocol-error');
			return;
		}

		if (
			!parsed ||
			typeof parsed !== 'object' ||
			!('type' in parsed) ||
			typeof (parsed as { type: unknown }).type !== 'string'
		) {
			ws.close(4400, 'protocol-error');
			return;
		}

		const frame = parsed as { type: string; id?: unknown; result?: unknown };
		if (frame.type !== 'dispatch_response') {
			ws.close(4400, 'protocol-error');
			return;
		}

		const id = typeof frame.id === 'string' ? frame.id : null;
		if (!id) return;

		const pending = this.pendingDispatches.get(id);
		if (!pending) return; // late response, HTTP request already gone

		if (!isDispatchResult(frame.result)) {
			// Recipient sent a non-`Result` payload; treat it as offline so the
			// caller gets a usable `Result` instead of waiting for the timeout.
			this.pendingDispatches.delete(id);
			pending.resolve(recipientOffline(installationId));
			return;
		}

		this.pendingDispatches.delete(id);
		pending.resolve(frame.result);
	}

	/**
	 * Clean up a closed WebSocket connection.
	 *
	 * - Rebroadcasts the presence list if this was the last socket for the
	 *   install (debounced, or immediately on auth-failure close codes).
	 * - Resolves any in-flight dispatches to this recipient with
	 *   `RecipientOffline` so callers don't wait for the safety timeout.
	 * - Schedules deferred compaction if the last socket just left.
	 */
	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const installationId = this.connections.get(ws);
		if (installationId === undefined) return;

		// Fail any in-flight dispatches that were waiting on this socket.
		// `pending.resolve` clears the safety timeout via its closure, so we
		// only need to delete the map entry and call resolve here.
		for (const [id, pending] of this.pendingDispatches) {
			if (pending.recipientWs !== ws) continue;
			this.pendingDispatches.delete(id);
			pending.resolve(recipientOffline(installationId));
		}

		this.connections.delete(ws);

		// Presence: if this was the LAST socket for the install, room
		// membership changed. Close code 4401 (permanent auth failure)
		// rebroadcasts immediately; every other close code debounces the
		// rebroadcast so a graceful tab handoff does not produce a flap.
		if (this.countInstallSockets(installationId) === 0) {
			if (code === Room.CLOSE_CODE_AUTH_FAILED) {
				this.cancelPendingRebroadcast();
				this.broadcastPresence();
			} else {
				this.schedulePresenceRebroadcast();
			}
		}

		try {
			ws.close(code, reason);
		} catch {
			/* already closed by the remote end */
		}

		if (this.connections.size === 0) {
			void this.ctx.storage.setAlarm(Date.now() + COMPACTION_DELAY_MS);
		}
	}

	/**
	 * Handle a WebSocket error by closing with status 1011 (Internal Error).
	 * Delegates to {@link webSocketClose} so the same cleanup path runs
	 * regardless of whether the socket closed cleanly or errored.
	 */
	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		await this.webSocketClose(ws, 1011, 'WebSocket error', false);
	}

	// --- Alarm: deferred compaction ---

	/**
	 * Compact the update log after all clients disconnect.
	 *
	 * Scheduled 30s after the last WebSocket closes via `ctx.storage.setAlarm`.
	 * Cancelled if a client reconnects before the alarm fires (see `upgrade()`).
	 *
	 * @see {@link https://developers.cloudflare.com/durable-objects/api/alarms/ | Durable Objects Alarms}
	 */
	override async alarm(): Promise<void> {
		if (this.connections.size > 0) return;
		compactUpdateLog(this.ctx, this.doc);
	}
}

// ============================================================================
// Dispatch wire helpers
// ============================================================================

/**
 * The relay's one self-produced dispatch outcome: the recipient has no
 * usable socket (never connected, dropped mid-flight, timed out, or sent
 * a non-`Result` reply). Shaped as `Err` so the wire body is always a
 * `Result`. The return type is pinned to the wire contract's
 * `RecipientOffline` variant, so a field added there fails to compile here.
 */
function recipientOffline(
	to: string,
): Result<unknown, Extract<DispatchErrorWire, { name: 'RecipientOffline' }>> {
	return Err({ name: 'RecipientOffline', to });
}

/**
 * Structural check that an untrusted wire value is a wellcrafted `Result`
 * (`{ data, error }`, both keys present). The relay forwards a recipient's
 * reply opaquely: it never inspects `error`, so the honest narrowed type is
 * `Result<unknown, unknown>`. The caller (`dispatch.ts`) is what validates
 * the error against `DispatchErrorWire`.
 */
function isDispatchResult(value: unknown): value is Result<unknown, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'data' in value &&
		'error' in value
	);
}

// ============================================================================
// compactUpdateLog
// ============================================================================

/**
 * Compact the SQLite update log into a single row.
 *
 * Encodes the current doc state via `Y.encodeStateAsUpdateV2`: produces
 * smaller output than `Y.mergeUpdatesV2` because deleted items become
 * lightweight GC structs (with `gc: true`) and struct merging is more
 * thorough. Also avoids the exponential performance edge case documented
 * in yjs#710.
 *
 * No-ops if the log already has <= 1 row or the compacted blob exceeds
 * the 2 MB per-row BLOB limit.
 *
 * @see {@link https://github.com/yjs/yjs/issues/710 | yjs#710 mergeUpdatesV2 performance}
 */
function compactUpdateLog(ctx: DurableObjectState, doc: Y.Doc): void {
	const rowCount = ctx.storage.sql
		.exec('SELECT COUNT(*) as count FROM updates')
		.one().count as number;
	if (rowCount <= 1) return;

	const compacted = Y.encodeStateAsUpdateV2(doc);
	if (compacted.byteLength > MAX_COMPACTED_BYTES) return;

	ctx.storage.transactionSync(() => {
		ctx.storage.sql.exec('DELETE FROM updates');
		ctx.storage.sql.exec('INSERT INTO updates (data) VALUES (?)', compacted);
	});

	console.log(`[compaction] ${rowCount} rows to ${compacted.byteLength} bytes`);
}
