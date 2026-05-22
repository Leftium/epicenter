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
 * Two surfaces share one authenticated socket but are independent at the
 * wire level:
 *
 *   binary WS frames  -> standard y-protocols SYNC.
 *   text WS frames    -> live-device dispatch and the server-owned
 *                        presence channel (`presence`).
 *
 * Dispatch is relay-mediated and rides text frames: a caller's
 * `dispatch_request` is routed to the recipient as `dispatch_inbound`; the
 * recipient's `dispatch_response` is routed back to the caller as
 * `dispatch_result`, correlated by a caller-minted `id`.
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
	handleSyncPayload,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	type SyncMessageType,
	stateVectorsEqual,
} from '@epicenter/sync';
import type {
	DispatchErrorWire,
	DispatchInboundFrame,
	DispatchResultFrame,
} from '@epicenter/workspace/document/dispatch-protocol';
import type { PresenceFrame } from '@epicenter/workspace/document/presence';
import * as decoding from 'lib0/decoding';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from './constants';

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
 * How long the relay holds an in-flight dispatch before answering the
 * caller with `RecipientOffline`. This bounds the `pendingDispatches` map
 * for long-lived sockets; it is not the caller's deadline. The caller's
 * `dispatch()` carries its own ceiling (it has to: a hibernated DO loses
 * this timer along with the in-memory map), so this only needs to be a
 * reasonable relay-side cap.
 */
const DISPATCH_INTERNAL_TIMEOUT_MS = 60_000;

/**
 * Errors from the room's untrusted-input boundaries.
 *
 * `MessageDecode` covers the WebSocket binary frame path; `MalformedSyncBody`
 * covers the HTTP sync RPC body. Both wrap lib0 buffer underflow (truncated
 * input) and any other decode-time exception thrown on untrusted bytes.
 */
const RoomError = defineErrors({
	MessageDecode: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode WebSocket message: ${extractErrorMessage(cause)}`,
		cause,
	}),
	MalformedSyncBody: ({ cause }: { cause: unknown }) => ({
		message: `Failed to decode HTTP sync body: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

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
 * **RPC** (`stub.sync()`, `stub.getDoc()`): for HTTP sync and snapshot
 *   bootstrap. Direct method calls avoid Request/Response serialization
 *   overhead for binary payloads.
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
	 * WebSocket close code emitted by the auth layer when the connection's
	 * credentials are permanently invalid. Bypasses the presence grace
	 * window: peers see the install drop immediately instead of waiting
	 * 300 ms for a handoff that cannot happen.
	 */
	private static readonly CLOSE_CODE_AUTH_FAILED = 4401;

	/**
	 * In-flight dispatches awaiting a `dispatch_response`. Keyed by the
	 * caller-minted correlation id. Each entry is a plain routing record:
	 * the caller socket the `dispatch_result` goes back to, the recipient
	 * socket the call is waiting on, and the safety timeout that answers
	 * `RecipientOffline` if the recipient never replies.
	 */
	private pendingDispatches = new Map<
		string,
		{
			callerWs: WebSocket;
			recipientWs: WebSocket;
			timeout: ReturnType<typeof setTimeout>;
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

	// --- RPC methods (called via stub.sync() / stub.getDoc()) ---

	/**
	 * HTTP sync via RPC.
	 *
	 * Binary body format: `[length-prefixed stateVector][length-prefixed update]`
	 * (encoded via `encodeSyncRequest` from `@epicenter/sync`).
	 *
	 * Applies the client update to the live doc and returns the binary diff
	 * the client is missing (or `null` if already in sync) wrapped in `Ok`.
	 * Returns `Err(MalformedSyncBody)` when the untrusted body fails to
	 * decode, so the route can answer 400 instead of 500.
	 */
	async sync(body: Uint8Array) {
		// `decodeSyncRequest` (lib0 framing) and `applyUpdateV2` (the V2
		// decoder) both throw on truncated or corrupt bytes, and the body is
		// untrusted. Guard the decode here so the route turns a failure into
		// 400; this mirrors the WebSocket path's boundary in webSocketMessage.
		const { data: clientSV, error } = trySync({
			try: () => {
				const { stateVector, update } = decodeSyncRequest(body);
				if (update.byteLength > 0) {
					Y.applyUpdateV2(this.doc, update, 'http');
				}
				return stateVector;
			},
			catch: (cause) => RoomError.MalformedSyncBody({ cause }),
		});
		if (error) return Err(error);

		const serverSV = Y.encodeStateVector(this.doc);
		const diff = stateVectorsEqual(serverSV, clientSV)
			? null
			: Y.encodeStateAsUpdateV2(this.doc, clientSV);

		return Ok({
			diff,
			storageBytes: this.ctx.storage.sql.databaseSize,
		});
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

	// --- Presence helpers ---

	/**
	 * Snapshot of currently-connected `installationId`s, deduped (multi-tab
	 * same-install collapses to one entry). Pass `exclude` to omit the
	 * caller's own socket; if the caller's installationId still has other
	 * open sockets, those siblings are excluded too. The result is "remote
	 * installs" from the perspective of the receiver.
	 */
	private snapshotInstalls(exclude?: WebSocket): string[] {
		const excludeInstall = exclude ? this.connections.get(exclude) : undefined;
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
		}, PRESENCE_REBROADCAST_GRACE_MS);
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
	 *   - text frames: dispatch correlation (`dispatch_request`,
	 *     `dispatch_response`) and other client text frames.
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

		const { data: reply, error } = trySync({
			try: () => {
				const decoder = decoding.createDecoder(new Uint8Array(message));
				const syncType = decoding.readVarUint(decoder) as SyncMessageType;
				const payload = decoding.readVarUint8Array(decoder);
				const response = handleSyncPayload({
					syncType,
					payload,
					doc: this.doc,
					origin: ws,
				});
				return response ?? null;
			},
			catch: (cause) => RoomError.MessageDecode({ cause }),
		});
		if (error) {
			console.error(error.message);
			return;
		}
		if (reply) ws.send(reply);
	}

	/**
	 * Route a client -> relay text frame. Valid types are `dispatch_request`
	 * (a caller starting a dispatch) and `dispatch_response` (a recipient
	 * answering one). Unparseable JSON or an unknown frame type is a genuine
	 * protocol desync and closes the socket with `4400 protocol-error`; a
	 * recognized frame with malformed fields is dropped without closing,
	 * because one bad dispatch frame must not tear down sync and presence.
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

		const frame = parsed as { type: string } & Record<string, unknown>;
		switch (frame.type) {
			case 'dispatch_request':
				this.handleDispatchRequest(ws, frame);
				return;
			case 'dispatch_response':
				this.handleDispatchResponse(installationId, frame);
				return;
			default:
				ws.close(4400, 'protocol-error');
		}
	}

	/**
	 * Caller -> relay: start a dispatch. Picks the most-recently-connected
	 * socket for `to`, pushes `dispatch_inbound` to it, and records the
	 * pending entry so the recipient's `dispatch_response` can be routed
	 * back to `callerWs`. A malformed frame is dropped silently: the
	 * caller's own ceiling settles it.
	 */
	private handleDispatchRequest(
		callerWs: WebSocket,
		frame: Record<string, unknown>,
	): void {
		const { id, to, action, input } = frame;
		if (
			typeof id !== 'string' ||
			typeof to !== 'string' ||
			typeof action !== 'string'
		) {
			return;
		}

		const recipientWs = this.pickRecipient(to);
		if (!recipientWs) {
			this.sendDispatchResult(callerWs, id, recipientOffline(to));
			return;
		}

		const timeout = setTimeout(() => {
			const pending = this.pendingDispatches.get(id);
			if (!pending) return;
			this.pendingDispatches.delete(id);
			this.sendDispatchResult(pending.callerWs, id, recipientOffline(to));
		}, DISPATCH_INTERNAL_TIMEOUT_MS);

		this.pendingDispatches.set(id, { callerWs, recipientWs, timeout });

		try {
			recipientWs.send(
				JSON.stringify({
					type: 'dispatch_inbound',
					id,
					action,
					input,
				} satisfies DispatchInboundFrame),
			);
		} catch {
			// Recipient socket died between pickRecipient and send.
			clearTimeout(timeout);
			this.pendingDispatches.delete(id);
			this.sendDispatchResult(callerWs, id, recipientOffline(to));
		}
	}

	/**
	 * Recipient -> relay: an action outcome. Routes the result back to the
	 * caller that started the dispatch. A `dispatch_response` with no
	 * matching pending entry is a late reply (the caller already gave up,
	 * or the entry was lost to hibernation) and is dropped.
	 */
	private handleDispatchResponse(
		installationId: string,
		frame: Record<string, unknown>,
	): void {
		const id = typeof frame.id === 'string' ? frame.id : null;
		if (!id) return;

		const pending = this.pendingDispatches.get(id);
		if (!pending) return;

		clearTimeout(pending.timeout);
		this.pendingDispatches.delete(id);

		const result = frame.result;
		const isResult =
			typeof result === 'object' &&
			result !== null &&
			'data' in result &&
			'error' in result;
		if (!isResult) {
			// Recipient sent a non-`Result` payload; treat it as offline so the
			// caller gets a usable `Result` instead of waiting for its ceiling.
			this.sendDispatchResult(
				pending.callerWs,
				id,
				recipientOffline(installationId),
			);
			return;
		}

		// The relay forwards the recipient's reply opaquely: it never inspects
		// the error side. The caller validates errors against `DispatchErrorWire`.
		this.sendDispatchResult(
			pending.callerWs,
			id,
			result as Result<unknown, unknown>,
		);
	}

	/**
	 * Send a `dispatch_result` frame to the caller socket. A dead caller
	 * socket is swallowed: its close event already ran (or will run) the
	 * pending-entry cleanup.
	 */
	private sendDispatchResult(
		callerWs: WebSocket,
		id: string,
		result: Result<unknown, unknown>,
	): void {
		try {
			callerWs.send(
				JSON.stringify({
					type: 'dispatch_result',
					id,
					result,
				} satisfies DispatchResultFrame),
			);
		} catch {
			/* caller socket already dead; close cleanup handles the entry */
		}
	}

	/**
	 * Clean up a closed WebSocket connection.
	 *
	 * - Rebroadcasts the presence list if this was the last socket for the
	 *   install (debounced, or immediately on auth-failure close codes).
	 * - Fails any in-flight dispatches touching this socket: a closed
	 *   recipient answers the caller `RecipientOffline`; a closed caller
	 *   just drops the entry.
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

		// Fail any in-flight dispatches touching this socket. A closed
		// recipient answers the caller `RecipientOffline`; a closed caller
		// just drops the entry (nobody to answer).
		for (const [id, pending] of this.pendingDispatches) {
			if (pending.recipientWs === ws) {
				clearTimeout(pending.timeout);
				this.pendingDispatches.delete(id);
				this.sendDispatchResult(
					pending.callerWs,
					id,
					recipientOffline(installationId),
				);
			} else if (pending.callerWs === ws) {
				clearTimeout(pending.timeout);
				this.pendingDispatches.delete(id);
			}
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
