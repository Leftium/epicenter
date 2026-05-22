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
 *                        presence channel (`presence_snapshot`,
 *                        `presence_added`, `presence_removed`).
 *   RPC method        -> {@link Room.dispatch}: the Worker forwards
 *                        a route-level `/dispatch` request here. The DO mints
 *                        a correlation id, pushes `dispatch_inbound` to
 *                        the recipient's socket, and resolves the RPC
 *                        promise when the recipient's `dispatch_response`
 *                        arrives.
 *
 * ## Presence
 *
 * Presence is server-owned: the `connections` map is the source of truth,
 * and the DO emits three text frame types (`presence_snapshot`,
 * `presence_added`, `presence_removed`) so clients can derive
 * `devices.list()` directly from the relay's view. There is no Awareness
 * instance on the relay; the y-protocols Awareness slot is reserved for
 * future cursor/typing/selection work, not liveness.
 */

import { DurableObject } from 'cloudflare:workers';
import {
	decodeSyncRequest,
	encodeSyncStep1,
	MAIN_SUBPROTOCOL,
	parseSubprotocols,
	stateVectorsEqual,
} from '@epicenter/sync';
import type {
	PresenceAddedFrame,
	PresenceRemovedFrame,
	PresenceSnapshotFrame,
} from '@epicenter/workspace/document/presence';
import * as Y from 'yjs';
import { MAX_PAYLOAD_BYTES } from './constants';
import {
	applyMessage,
	type Connection,
	registerConnection,
} from './sync-handlers';

// ============================================================================
// Dispatch wire types (text frames + RPC)
// ============================================================================

/**
 * Server -> recipient text frame. Pushed by the DO when an HTTP dispatch
 * call resolves a live socket for `to`. The recipient runs the action and
 * replies with `dispatch_response` carrying the same `id`.
 */
type DispatchInboundFrame = {
	type: 'dispatch_inbound';
	id: string;
	from: string;
	action: string;
	input: unknown;
};

/** Wire form of a `Result<unknown, DispatchError>`. */
export type DispatchResult = { data: unknown } | { error: DispatchErrorWire };

export type DispatchErrorWire =
	| { name: 'RecipientOffline'; to: string; message: string }
	| { name: 'ActionNotFound'; action: string; message: string }
	| {
			name: 'ActionFailed';
			action: string;
			cause: string;
			message: string;
	  };

export type DispatchRpcRequest = {
	from: string;
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
 * Grace window before a `presence_removed` broadcast fires after the last
 * socket for an install closes.
 *
 * A graceful tab handoff (T1 closes, T2 connects within a few hundred ms)
 * would otherwise emit `presence_removed(X)` immediately followed by
 * `presence_added(X)`, even though install X was continuously present from
 * the user's perspective. The grace window lets `upgrade()` cancel the
 * pending removed-broadcast before peers ever see the flap.
 *
 * Close-code policy: WebSocket close code 4401 (permanent auth failure)
 * bypasses the grace window and emits `presence_removed` immediately. There
 * is no legitimate handoff for an auth-failed socket, and forcing peers to
 * wait 300 ms to learn an install is permanently offline yields no benefit.
 * All other close codes (1000, 1006, 1009, 1011, 4400, ...) respect the
 * grace window.
 *
 * 300 ms is a starting point. See the spec's "Grace-window justification"
 * section for the rationale.
 */
const PRESENCE_REMOVE_GRACE_MS = 300;

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
 * DO names are host-owned opaque strings. Legacy rooms use
 * `subject:{subject}:rooms:{room}`. Cloud Workspace app docs use
 * `v1:workspace:{workspaceId}:app:{appId}:doc:{docId}`. The relay treats
 * `from` on a dispatch as a routing label inside the already authorized room,
 * not as a cross-room auth principal.
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

	/** Active WebSocket connections and their per-connection sync state. */
	private connections = new Map<WebSocket, Connection>();

	/**
	 * Pending `presence_removed` broadcasts, keyed by installationId. Armed
	 * when the last socket for an install closes; cleared either by the
	 * timeout firing (real disconnect) or by a new socket for the same
	 * install arriving inside the grace window (handoff).
	 *
	 * Per-installation rather than per-socket so a graceful tab handoff
	 * (close T1, open T2 within grace) cancels exactly the right pending
	 * broadcast.
	 */
	private pendingRemovals = new Map<string, ReturnType<typeof setTimeout>>();

	/**
	 * @see {@link PRESENCE_REMOVE_GRACE_MS}
	 */
	private static readonly PRESENCE_REMOVE_GRACE_MS = PRESENCE_REMOVE_GRACE_MS;

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
			resolve: (result: DispatchResult) => void;
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

			// --- Restore connections that survived hibernation ---
			// Iterates ctx.getWebSockets(), reads the URL-stamped installationId
			// from each attachment, and re-registers sync handlers.
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

				const connection = registerConnection({
					doc: this.doc,
					ws,
					installationId: attachment.installationId,
				});
				this.connections.set(ws, connection);
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

		const connection = registerConnection({
			doc: this.doc,
			ws: server,
			installationId,
		});
		this.connections.set(server, connection);

		server.send(encodeSyncStep1({ doc: this.doc }));

		// Presence: send the snapshot to the new socket, then broadcast
		// `presence_added` to existing sockets if and only if this is the
		// FIRST socket for `installationId` (multi-tab subsequent sockets
		// do not re-announce the install). If a `presence_removed` was
		// pending from a just-closed sibling socket, cancel it and emit
		// nothing to peers: from their point of view the install never left.
		server.send(
			JSON.stringify({
				type: 'presence_snapshot',
				installs: this.snapshotInstalls(server),
			} satisfies PresenceSnapshotFrame),
		);

		if (this.countInstallSockets(installationId) === 1) {
			if (!this.cancelPendingRemoval(installationId)) {
				this.presenceBroadcast(
					{ type: 'presence_added', install: installationId } satisfies PresenceAddedFrame,
					server,
				);
			}
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
	 * (encoded via `encodeSyncRequest` from sync-core).
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
	async dispatch(req: DispatchRpcRequest): Promise<DispatchResult> {
		const recipientWs = this.pickRecipient(req.to);
		if (!recipientWs) {
			return {
				error: {
					name: 'RecipientOffline',
					to: req.to,
					message: `Recipient "${req.to}" is offline`,
				},
			};
		}

		const id = crypto.randomUUID();
		const frame: DispatchInboundFrame = {
			type: 'dispatch_inbound',
			id,
			from: req.from,
			action: req.action,
			input: req.input,
		};

		return new Promise<DispatchResult>((resolve) => {
			const timeoutHandle = setTimeout(() => {
				if (!this.pendingDispatches.has(id)) return;
				this.pendingDispatches.delete(id);
				resolve({
					error: {
						name: 'RecipientOffline',
						to: req.to,
						message: `Recipient "${req.to}" is offline`,
					},
				});
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
					pending.resolve({
						error: {
							name: 'RecipientOffline',
							to: req.to,
							message: `Recipient "${req.to}" is offline`,
						},
					});
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
			? this.connections.get(exclude)?.installationId
			: undefined;
		const seen = new Set<string>();
		for (const [ws, connection] of this.connections) {
			if (ws === exclude) continue;
			if (excludeInstall && connection.installationId === excludeInstall) {
				continue;
			}
			seen.add(connection.installationId);
		}
		return Array.from(seen).sort();
	}

	/**
	 * Count the number of OPEN sockets currently associated with
	 * `installationId`. Used to gate `presence_added` (only the first
	 * socket emits) and `presence_removed` (only the last close emits).
	 */
	private countInstallSockets(installationId: string): number {
		let count = 0;
		for (const [, connection] of this.connections) {
			if (connection.installationId === installationId) count++;
		}
		return count;
	}

	/**
	 * Fan out a presence frame to every connection other than `exclude`.
	 * Wraps each `ws.send` in try/catch so a wedged socket cannot abort
	 * the loop (the close event will fire and trigger the full cleanup
	 * path eventually).
	 */
	private presenceBroadcast(
		frame: PresenceSnapshotFrame | PresenceAddedFrame | PresenceRemovedFrame,
		exclude?: WebSocket,
	): void {
		const payload = JSON.stringify(frame);
		for (const [peer] of this.connections) {
			if (peer === exclude) continue;
			if (peer.readyState !== WebSocket.OPEN) continue;
			try {
				peer.send(payload);
			} catch {
				/* peer's close event will run the full cleanup path */
			}
		}
	}

	/**
	 * Arm a `presence_removed` broadcast for `installationId` after the
	 * grace window. If an upgrade for the same install lands inside the
	 * window, {@link cancelPendingRemoval} clears the pending broadcast so
	 * peers never see a flap. If the timer fires and the install still
	 * has zero sockets, the broadcast goes out.
	 *
	 * Re-arming for an install with an existing pending removal replaces
	 * the older timer; the install's eventual `presence_removed` lands at
	 * `now + grace`, not at the original `lastClose + grace`.
	 */
	private schedulePresenceRemoved(installationId: string): void {
		const existing = this.pendingRemovals.get(installationId);
		if (existing) clearTimeout(existing);
		const handle = setTimeout(() => {
			this.pendingRemovals.delete(installationId);
			if (this.countInstallSockets(installationId) > 0) return;
			this.presenceBroadcast({
				type: 'presence_removed',
				install: installationId,
			} satisfies PresenceRemovedFrame);
		}, Room.PRESENCE_REMOVE_GRACE_MS);
		this.pendingRemovals.set(installationId, handle);
	}

	/**
	 * Cancel a pending `presence_removed` for `installationId`. Returns
	 * `true` if a pending broadcast was actually cancelled (graceful tab
	 * handoff), `false` if no timer was armed (genuinely first socket for
	 * this install).
	 *
	 * `upgrade()` uses the return value to decide whether to emit
	 * `presence_added`: a cancelled removal means peers never observed
	 * the install leave, so the add would be spurious.
	 */
	private cancelPendingRemoval(installationId: string): boolean {
		const handle = this.pendingRemovals.get(installationId);
		if (!handle) return false;
		clearTimeout(handle);
		this.pendingRemovals.delete(installationId);
		return true;
	}

	/**
	 * Emit `presence_removed` for `installationId` right now, bypassing
	 * the grace window. Used for close code 4401 (permanent auth failure)
	 * where no legitimate handoff is possible.
	 *
	 * Also clears any pending grace-window timer for the same install so
	 * a stale timer from an earlier non-auth close cannot double-fire.
	 */
	private presenceRemovedImmediate(installationId: string): void {
		this.cancelPendingRemoval(installationId);
		this.presenceBroadcast({
			type: 'presence_removed',
			install: installationId,
		} satisfies PresenceRemovedFrame);
	}

	/**
	 * Resolve a recipient `installationId` to the most-recently-connected
	 * open socket, if any. Iteration order in `Map` is insertion order, so
	 * the *last* match in a forward scan is the newest.
	 */
	private pickRecipient(installationId: string): WebSocket | null {
		let newest: WebSocket | null = null;
		for (const [ws, connection] of this.connections) {
			if (
				connection.installationId === installationId &&
				ws.readyState === WebSocket.OPEN
			) {
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
		const connection = this.connections.get(ws);
		if (!connection) return;

		const byteLength =
			message instanceof ArrayBuffer ? message.byteLength : message.length;
		if (byteLength > MAX_PAYLOAD_BYTES) {
			ws.close(1009, 'Message too large');
			return;
		}

		if (typeof message === 'string') {
			this.handleTextFrame(ws, connection, message);
			return;
		}

		const { data: reply, error } = applyMessage({
			data: new Uint8Array(message),
			doc: this.doc,
			connection,
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
		connection: Connection,
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

		const result = frame.result as DispatchResult | undefined;
		if (!isDispatchResult(result)) {
			// Recipient sent a malformed result; treat as offline so the caller
			// gets a usable Result rather than hanging until the safety timeout.
			this.pendingDispatches.delete(id);
			pending.resolve({
				error: {
					name: 'RecipientOffline',
					to: connection.installationId,
					message: 'Recipient returned a malformed dispatch response',
				},
			});
			return;
		}

		this.pendingDispatches.delete(id);
		pending.resolve(result);
	}

	/**
	 * Clean up a closed WebSocket connection.
	 *
	 * - Emits `presence_removed` if this was the last socket for the
	 *   install (or immediately on auth-failure close codes).
	 * - Resolves any in-flight dispatches to this recipient with
	 *   `RecipientOffline` so callers don't wait for the safety timeout.
	 * - Unregisters Yjs doc update handlers.
	 * - Schedules deferred compaction if the last socket just left.
	 */
	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		const connection = this.connections.get(ws);
		if (!connection) return;

		// Fail any in-flight dispatches that were waiting on this socket.
		// `pending.resolve` clears the safety timeout via its closure, so we
		// only need to delete the map entry and call resolve here.
		for (const [id, pending] of this.pendingDispatches) {
			if (pending.recipientWs !== ws) continue;
			this.pendingDispatches.delete(id);
			pending.resolve({
				error: {
					name: 'RecipientOffline',
					to: connection.installationId,
					message: `Recipient "${connection.installationId}" is offline`,
				},
			});
		}

		connection.unregister();
		this.connections.delete(ws);

		// Presence: if this was the LAST socket for the install, emit
		// `presence_removed`. Close code 4401 (permanent auth failure)
		// bypasses the grace window; every other close code respects it so
		// graceful tab handoffs do not produce a wire-visible flap.
		if (this.countInstallSockets(connection.installationId) === 0) {
			if (code === Room.CLOSE_CODE_AUTH_FAILED) {
				this.presenceRemovedImmediate(connection.installationId);
			} else {
				this.schedulePresenceRemoved(connection.installationId);
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
// Dispatch wire validators
// ============================================================================

/** Structural check that `value` is a wire-shaped `DispatchResult`. */
function isDispatchResult(value: unknown): value is DispatchResult {
	if (!value || typeof value !== 'object') return false;
	const hasData = 'data' in value;
	const hasError = 'error' in value;
	if (hasData && hasError) return false;
	if (!hasData && !hasError) return false;
	return true;
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
