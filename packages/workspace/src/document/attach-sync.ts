/// <reference lib="dom" />

import {
	BEARER_SUBPROTOCOL_PREFIX,
	decodeRpcPayload,
	encodeAwareness,
	encodeAwarenessStates,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	isRpcError,
	MAIN_SUBPROTOCOL,
	MESSAGE_TYPE,
	RpcError,
	SYNC_MESSAGE_TYPE,
	SYNC_ORIGIN,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
	Awareness as YAwareness,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { DefaultRpcMap, RpcActionMap } from '../rpc/types.js';
import {
	defineQuery,
	describeActions,
	invokeActionForRpc,
	type RemoteCallOptions,
	resolveActionPath,
	type SystemActions,
} from '../shared/actions.js';
import {
	createAwareness,
	type Awareness as TypedAwareness,
} from './attach-awareness.js';
import {
	type DeviceDescriptor,
	type FoundPeer,
	type PeerAwarenessState,
	standardAwarenessDefs,
} from './standard-awareness-defs.js';

/**
 * Minimal Y.Doc sync attachment — connects a Y.Doc to a WebSocket sync server.
 *
 * This is a low-level primitive for `packages/document`. It handles the
 * Y.Doc sync protocol (STEP1/STEP2/UPDATE), optional awareness, supervisor
 * loop with exponential backoff, liveness detection, and graceful shutdown.
 *
 * **Not included** (workspace-layer concerns):
 * - BroadcastChannel cross-tab sync (separate `attachBroadcastChannel` helper)
 *
 * Optional RPC between peers is supported via the callback-based `rpc` config.
 * Provide `rpc.dispatch(action, input)` to handle inbound requests; outbound
 * calls are made via the returned `rpc()` method.
 *
 * Register `attachIndexedDb` first and pass its `whenLoaded`
 * as `waitFor` so the supervisor connects only after local state hydrates:
 * the handshake then exchanges only the delta, not the full document.
 *
 * `SYNC_ORIGIN` is imported from `@epicenter/sync` so every sync layer
 * (workspace WebSocket, BroadcastChannel, document attachSync) agrees on the
 * same symbol and echo guards work across layers.
 */

// ============================================================================
// Types
// ============================================================================

export type SyncError =
	| { type: 'auth'; error: unknown }
	| { type: 'connection' };

/**
 * Reason a sync entered the terminal `failed` phase.
 *
 * `code` is `string` (not a closed enum): the server is the source of truth
 * for the vocabulary, so unknown codes pass through. Documented codes today:
 * 'invalid_token', 'token_expired', 'deauthorized', 'unknown'.
 */
export type SyncFailedReason = { type: 'auth'; code: string };

export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; retries: number; lastError?: SyncError }
	| { phase: 'connected'; hasLocalChanges: boolean }
	| { phase: 'failed'; reason: SyncFailedReason };

/**
 * Thrown via `whenConnected` rejection when the server signals a permanent
 * auth failure (close code 4401). The `code` carries the server's canonical
 * reason string so callers can switch on it without magic strings.
 */
export const SyncFailedError = defineErrors({
	AuthRejected: ({ code }: { code: string }) => ({
		message: `[attachSync] server rejected auth: ${code}`,
		code,
	}),
});
export type SyncFailedError = InferErrors<typeof SyncFailedError>;

/** Errors surfaced by the sync supervisor's background lifecycle. */
export const SyncSupervisorError = defineErrors({
	/**
	 * The `waitFor` barrier (typically IndexedDB hydration) rejected before
	 * the supervisor started. Sync proceeds anyway: better to try syncing
	 * than to stay silently offline because persistence failed.
	 */
	WaitForRejected: ({ cause }: { cause: unknown }) => ({
		message: `[attachSync] waitFor rejected; starting sync anyway: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/**
	 * The socket didn't fire 'close' within the shutdown timeout, so
	 * `whenDisposed` resolves anyway rather than hanging forever.
	 */
	CloseTimeout: ({ timeoutMs }: { timeoutMs: number }) => ({
		message: `[attachSync] WebSocket did not fire onclose within ${timeoutMs}ms; resolving whenDisposed anyway`,
		timeoutMs,
	}),
});
export type SyncSupervisorError = InferErrors<typeof SyncSupervisorError>;

export const PeerMiss = defineErrors({
	PeerMiss: ({
		peerTarget,
		sawPeers,
		waitMs,
		emptyReason,
	}: {
		peerTarget: string;
		sawPeers: boolean;
		waitMs: number;
		emptyReason: string | null;
	}) => ({
		message: `no peer matches deviceId "${peerTarget}"`,
		peerTarget,
		sawPeers,
		waitMs,
		emptyReason,
	}),
});
export type PeerMiss = InferErrors<typeof PeerMiss>;

function describeOfflineReason(status: SyncStatus): string | null {
	if (status.phase === 'connected') return null;
	if (status.phase === 'connecting' && status.lastError) {
		const retries = status.retries;
		const word = retries === 1 ? 'retry' : 'retries';
		return `not connected (${status.lastError.type} error after ${retries} ${word})`;
	}
	return 'not connected';
}

export type SyncAttachment = {
	/**
	 * Resolves after the WebSocket handshake completes and the first sync
	 * exchange finishes. Unlike `y-indexeddb`'s `whenSynced`, this is a
	 * real "transport established, initial state reconciled" guarantee.
	 *
	 * Rejects with an error if the doc is destroyed before the first
	 * successful handshake (permanent failure: dead URL, auth denied,
	 * dispose during outage). Callers awaiting it should attach a `.catch`
	 * or use `await using` to bound the wait by the doc's lifetime.
	 *
	 * Browser apps generally await `idb.whenLoaded` to render; only CLIs
	 * and tools that strictly need remote state await `whenConnected`.
	 */
	whenConnected: Promise<unknown>;
	/** Current connection status. */
	readonly status: SyncStatus;
	/** Subscribe to status changes. Returns unsubscribe function. */
	onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
	/**
	 * Close the websocket, stop the supervisor, and transition to offline.
	 * A subsequent `reconnect()` restarts the supervisor.
	 */
	goOffline: () => void;
	/** Force a fresh connection with new credentials (supervisor restarts iteration). */
	reconnect: () => void;
	/**
	 * Resolves after the ydoc is destroyed and the websocket teardown completes.
	 * Named symmetrically with `whenConnected` — both are promises.
	 */
	whenDisposed: Promise<unknown>;
	/**
	 * Invoke an action on a remote peer in this room.
	 *
	 * Pass a type map (e.g. from workspace's `InferSyncRpcMap`) for full type
	 * safety, or omit it for untyped calls.
	 *
	 * @param target - Awareness clientId of the target peer
	 * @param action - Dot-path action name (e.g. `'tabs.close'`)
	 * @param input - Action input (serialized as JSON)
	 * @param options - Optional timeout override (default 5000ms)
	 */
	rpc<
		TMap extends RpcActionMap = DefaultRpcMap,
		TAction extends string & keyof TMap = string & keyof TMap,
	>(
		target: number,
		action: TAction,
		input?: TMap[TAction]['input'],
		options?: RemoteCallOptions,
	): Promise<Result<TMap[TAction]['output'], RpcError>>;
	/**
	 * Snapshot of every connected peer (excludes self). Empty when this
	 * sync wasn't constructed with a `device` (i.e. no presence published).
	 */
	peers(): Map<number, PeerAwarenessState>;
	/**
	 * First peer publishing `deviceId`, by ascending clientId. Returns
	 * `undefined` when no peer matches or when no presence is configured.
	 */
	find(deviceId: string): FoundPeer | undefined;
	/**
	 * Wait for a peer publishing `deviceId` to appear in awareness.
	 * Resolves with a `PeerMiss` value when the budget expires.
	 */
	waitForPeer(
		deviceId: string,
		options: { timeoutMs: number },
	): Promise<Result<FoundPeer, PeerMiss>>;
	/**
	 * Subscribe to peer change events. Fires when peers join, leave, or
	 * update their state. Returns an unsubscribe function. No-op when no
	 * presence is configured.
	 */
	observe(callback: () => void): () => void;
	/**
	 * Escape hatch — the underlying y-protocols handles. Use for advanced
	 * cases (custom event listeners, integrations expecting raw types).
	 * `awareness` is `null` when no presence was configured.
	 */
	raw: { awareness: YAwareness | null };
};

/**
 * Anything with a `.whenLoaded` promise (typically `attachIndexedDb` or
 * `attachSqlite` results). Lets `waitFor` accept the attachment directly
 * rather than reaching into `.whenLoaded`.
 */
export type WaitForBarrier =
	| Promise<unknown>
	| { whenLoaded: Promise<unknown> };

/**
 * First arg of `attachSync`. Either a bare `Y.Doc` (content docs) or a
 * doc bundle (workspace docs). When a bundle is passed and no `actions`
 * override is set in config, sync uses the bundle ITSELF as the action
 * source: `walkActions` filters to action leaves at runtime, so actions
 * can live anywhere in the tree, not under a reserved `actions:` key.
 */
export type AttachSyncDoc = Y.Doc | { ydoc: Y.Doc };

export type SyncWebSocket = {
	readyState: number;
	binaryType: BinaryType;
	onopen: ((ev: Event) => unknown) | null;
	onclose: ((ev: CloseEvent) => unknown) | null;
	onerror: ((ev: Event) => unknown) | null;
	onmessage: ((ev: MessageEvent) => void) | null;
	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
	close(code?: number, reason?: string): void;
	addEventListener(
		type: string,
		listener: EventListener,
		options?: AddEventListenerOptions,
	): void;
	removeEventListener(type: string, listener: EventListener): void;
};

export type WebSocketImpl = new (
	url: string,
	protocols?: string | string[],
) => SyncWebSocket;

export type SyncAttachmentConfig = {
	/**
	 * WebSocket URL for the room. Must use ws:/wss:. Use `toWsUrl()` to convert
	 * an HTTP URL. Typically interpolates `ydoc.guid` into the path.
	 */
	url: string;
	/**
	 * Gate the first connection attempt on another promise (typically
	 * `attachIndexedDb(ydoc).whenLoaded`). Accepts the attachment directly
	 * (uses its `.whenLoaded`) or a raw promise. Without this, the supervisor
	 * connects before local state hydrates and the handshake transfers the
	 * full document instead of just the delta.
	 */
	waitFor?: WaitForBarrier;
	/**
	 * Publish this peer's identity into awareness. When set, `attachSync`
	 * constructs a standard-schema awareness internally and synchronously
	 * publishes `{ device }` before returning. The attachment's `peers()` /
	 * `find()` / `observe()` become meaningful.
	 *
	 * Workspace docs pass this; content docs (entries, notes, files) omit
	 * it. They sync but don't publish identity.
	 *
	 * Mutually exclusive with `awareness` (an external instance). Pass one.
	 *
	 * Awareness carries presence only. There is no action manifest. Consumers that
	 * need to enumerate a peer's actions call
	 * `describeRemoteActions(sync, deviceId)` to fetch the full local
	 * `ActionManifest` on demand via the runtime-injected `system.describe`
	 * RPC.
	 */
	device?: DeviceDescriptor;
	/**
	 * External awareness instance. Escape hatch for custom presence schemas
	 * (cursors on content docs, typing indicators). When provided, sync
	 * carries presence over the wire but does NOT type the `peers()` /
	 * `find()` surface — those return empty/undefined since the schema is
	 * unknown to sync. Use the awareness's own typed wrapper instead.
	 *
	 * Standard "I am a device" presence: pass `device` instead.
	 */
	awareness?: YAwareness;
	/**
	 * Inbound action tree. Incoming RPC requests are routed by dot-path
	 * against this tree; raw returns get `Ok`-wrapped,
	 * throws become `Err(ActionFailed)`, and existing `Result`s are normalized
	 * to the RPC error envelope.
	 *
	 * Wrapping the dispatch path (auth gates, audit logs, rate limits) is
	 * an upstream concern. Compose the action tree itself before passing
	 * it here. Userland helpers like `withAuthGate(actions, ...)` are the
	 * right home for that, not a callback in this config.
	 *
	 * Defaults to the doc bundle itself (when first arg is a bundle), so
	 * actions hoisted to top-level keys (`tabs`, `devices`, etc.) are routed
	 * without a reserved `actions:` namespace. `walkActions` filters to
	 * action leaves at runtime, so non-action bundle keys (`ydoc`, `tables`,
	 * `kv`, …) are skipped. When neither this nor a bundle is passed,
	 * inbound RPCs receive `RpcError.ActionNotFound`. Outbound RPC works
	 * regardless.
	 */
	actions?: Record<string, unknown>;
	/**
	 * Token sourcing callback. When provided, the supervisor calls `getToken()`
	 * before each connect attempt to fetch a fresh bearer token (sent over the
	 * WebSocket subprotocol). Returning `null` keeps the supervisor parked in
	 * an `auth` error state until a subsequent `reconnect()` (or backoff
	 * iteration) finds a non-null token.
	 *
	 * May be sync or async — the supervisor `await`s either way. Sync returns
	 * skip the microtask hop in the common case where the token is already in
	 * memory.
	 *
	 * Providing this callback IS the declaration that the connection is
	 * authenticated. Omit it for unauthenticated providers (tests, public
	 * rooms) — `attachSync` then connects without a bearer subprotocol.
	 */
	getToken?: () => string | null | Promise<string | null>;
	/**
	 * WebSocket constructor. Tests can pass a stub to avoid dialing a server;
	 * production uses `globalThis.WebSocket`.
	 */
	webSocketImpl?: WebSocketImpl;
	/**
	 * Logger for background supervisor failures (waitFor rejections, socket
	 * close timeouts). Defaults to a console-backed logger with source
	 * `attachSync`.
	 */
	log?: Logger;
};

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 60_000;
const LIVENESS_TIMEOUT_MS = 90_000;
const LIVENESS_CHECK_INTERVAL_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * App-defined WebSocket close code (4000-4999 range) signaling the server
 * permanently rejected this connection's auth. Distinguishes "give up" from
 * transient close codes (1006 network blip, 1011 server error, etc.).
 */
const PERMANENT_AUTH_CLOSE_CODE = 4401;

/**
 * Failsafe: returns null when `event` is not a permanent-failure signal,
 * `SyncFailedReason` otherwise. A buggy server that sends 4401 with malformed
 * JSON or no reason still produces a usable reason (`code: 'unknown'`); we
 * never throw from here.
 */
function parsePermanentFailure(event: {
	code: number;
	reason: string;
}): SyncFailedReason | null {
	if (event.code !== PERMANENT_AUTH_CLOSE_CODE) return null;
	try {
		const parsed = JSON.parse(event.reason) as unknown;
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			'code' in parsed &&
			typeof (parsed as { code: unknown }).code === 'string'
		) {
			return { type: 'auth', code: (parsed as { code: string }).code };
		}
	} catch {
		// fall through to 'unknown'
	}
	return { type: 'auth', code: 'unknown' };
}

// ============================================================================
// Public API
// ============================================================================

export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

export function attachSync(
	doc: AttachSyncDoc,
	config: SyncAttachmentConfig,
): SyncAttachment {
	// Resolve doc bundle vs bare ydoc. When a bundle is passed and no
	// explicit `actions` override is set, the bundle ITSELF is the action
	// source: `walkActions` filters to action leaves at runtime.
	const ydoc = doc instanceof Y.Doc ? doc : doc.ydoc;
	const userActions =
		config.actions ?? (doc instanceof Y.Doc ? undefined : doc);

	if (userActions && 'system' in userActions) {
		throw new Error(
			"User actions cannot define the 'system.*' namespace — it's reserved " +
				"for runtime-injected meta operations. Use 'app', 'settings', " +
				"'config', or another app-specific noun.",
		);
	}

	// Inject `system.*` meta operations into the dispatch tree.
	// `system.describe` is argless and returns the full local
	// `ActionManifest` (dot-path to ActionMeta with live input schemas).
	// Consumers fetch on demand via `describeRemoteActions(sync, deviceId)`
	// rather than receiving a manifest broadcast in awareness.
	//
	// Type-annotate against `SystemActions` (the canonical type in
	// `shared/actions.ts`): TypeScript checks the runtime construction here
	// matches the type the `createRemoteActions<{ system: SystemActions }>`
	// proxy expects.
	// Drift between handler return and consumer expectation = compile error.
	//
	// Freeze the dispatch tree post-merge: the reservation check above
	// protects the namespace at construction; freezing prevents post-attach
	// mutation from injecting routes under `system.*`.
	const systemActions: SystemActions = Object.freeze({
		describe: defineQuery({
			handler: () => describeActions(userActions ?? {}),
		}),
	});
	const actions = Object.freeze({
		...(userActions ?? {}),
		system: systemActions,
	});

	if (config.device && config.awareness) {
		throw new Error(
			'[attachSync] pass either `device` (standard presence) or `awareness` ' +
				'(external instance for custom schemas) — not both.',
		);
	}

	// Awareness is internally-owned when `device` is provided; externally-owned
	// when `awareness` is provided; absent otherwise. Only the internal path
	// gets a typed wrapper (we know the schema there).
	let awareness: YAwareness | null = null;
	let typedAwareness: TypedAwareness<typeof standardAwarenessDefs> | null =
		null;
	if (config.device) {
		awareness = new YAwareness(ydoc);
		typedAwareness = createAwareness(awareness, standardAwarenessDefs);
		typedAwareness.setLocal({ device: config.device });
	} else if (config.awareness) {
		awareness = config.awareness;
	}

	const waitForPromise =
		config.waitFor && 'whenLoaded' in config.waitFor
			? config.waitFor.whenLoaded
			: config.waitFor;

	const log = config.log ?? createLogger('attachSync');

	const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });
	// `whenConnected` settles in one of two ways: resolved when the first
	// successful handshake lands (STEP2/UPDATE), rejected when the doc is
	// destroyed before that happens. Without the destroy-side rejection,
	// callers awaiting `whenConnected` against a permanently dead URL or
	// failed auth would hang forever.
	const {
		promise: whenConnected,
		resolve: resolveConnected,
		reject: rejectConnected,
	} = Promise.withResolvers<void>();
	let connectedSettled = false;
	const settleConnected = (op: () => void) => {
		if (connectedSettled) return;
		connectedSettled = true;
		op();
	};
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	const backoff = createBackoff();

	/**
	 * Set when the server signals permanent failure via close 4401. Read by
	 * `runLoop` to break the retry loop, and cleared by `reconnect()` so a
	 * subsequent attempt can leave the `failed` phase.
	 */
	let permanentFailure: SyncFailedReason | null = null;

	// `whenConnected` settles off status transitions. The first `connected`
	// resolves it; the first `failed` rejects with a typed `SyncFailedError`.
	// Doc-destroy still rejects via the destroy handler below; `connectedSettled`
	// gates double-settle.
	const unsubFirstSettle = status.subscribe((s) => {
		if (s.phase === 'connected') {
			settleConnected(resolveConnected);
			unsubFirstSettle();
		} else if (s.phase === 'failed') {
			// Attach the no-op catch BEFORE rejecting so the rejection isn't
			// unhandled when no consumer awaits (same pattern as the dispose
			// path further down).
			whenConnected.catch(() => {});
			const reason = s.reason;
			settleConnected(() => {
				rejectConnected(
					SyncFailedError.AuthRejected({ code: reason.code }).error,
				);
			});
			unsubFirstSettle();
		}
	});

	/**
	 * Whether this connection is authenticated. Inferred from the presence of
	 * `getToken` — supplying that callback IS the declaration that a token is
	 * required. Without it, the supervisor connects unauthenticated.
	 */
	const requiresToken = typeof config.getToken === 'function';

	/**
	 * Cancellation hierarchy:
	 *
	 *   masterController  ← aborts on doc.destroy(); kills everything
	 *      └─ cycleController  ← aborts on goOffline() / reconnect();
	 *                            kills the current supervisor iteration
	 *
	 * `cycleController` is replaced (not just re-aborted) by `reconnect()` so
	 * the new connection cycle has a fresh signal unrelated to the old one.
	 * Aborting an already-aborted controller is a no-op, which makes
	 * goOffline-then-reconnect races structurally safe.
	 */
	const masterController = new AbortController();
	let cycleController: AbortController = childOf(masterController.signal);

	/** Current WebSocket instance, or null. */
	let websocket: SyncWebSocket | null = null;

	/**
	 * Promise of the currently-running supervisor loop, or null when no loop
	 * is running. `ensureSupervisor` starts one if absent; teardown awaits it.
	 */
	let loopPromise: Promise<void> | null = null;

	/**
	 * SYNC_STATUS version tracking.
	 *
	 * `localVersion` increments on every local doc update. After a debounce
	 * quiet period, the client sends `encodeSyncStatus(localVersion)`; the
	 * server echoes the same payload back. The echoed value lands in
	 * `ackedVersion` — when `localVersion > ackedVersion`, there's local work
	 * the server hasn't confirmed yet.
	 *
	 * Both counters reset to 0 on each fresh connection (the server has no
	 * memory of our prior counters).
	 */
	let localVersion = 0;
	let ackedVersion = 0;
	let syncStatusTimer: ReturnType<typeof setTimeout> | null = null;

	// ── RPC state ──
	//
	// `pendingRequests` tracks outbound RPCs awaiting a response. Cleared on
	// disconnect (the next connection is a fresh server-side context, so any
	// in-flight request from the prior connection will never resolve).
	const pendingRequests = new Map<
		number,
		{
			action: string;
			resolve: (result: Result<unknown, unknown>) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let nextRequestId = 0;

	/** Resolve all pending RPC requests with Disconnected and clear state. */
	function clearPendingRequests() {
		const disconnected = RpcError.Disconnected();
		for (const [, pending] of pendingRequests) {
			clearTimeout(pending.timer);
			pending.resolve(disconnected);
		}
		pendingRequests.clear();
		nextRequestId = 0;
	}

	/**
	 * Handle an inbound RPC request: delegate action lookup to the caller
	 * via `config.dispatch`, and send the response back to the requester.
	 *
	 * When no dispatcher is configured, respond with `ActionNotFound` so the
	 * caller sees a typed error instead of a timeout.
	 */
	async function handleRpcRequest(rpc: {
		requestId: number;
		requesterClientId: number;
		action: string;
		input: unknown;
	}) {
		const sendResponse = (result: Result<unknown, unknown>) =>
			send(
				encodeRpcResponse({
					requestId: rpc.requestId,
					requesterClientId: rpc.requesterClientId,
					result,
				}),
			);

		// Resolve the action up front so a missing path surfaces as
		// ActionNotFound (typed) rather than ActionFailed wrapping a raw throw.
		const target = resolveActionPath(actions, rpc.action);
		if (!target) {
			sendResponse(RpcError.ActionNotFound({ action: rpc.action }));
			return;
		}

		sendResponse(await invokeActionForRpc(target, rpc.input, rpc.action));
	}

	// ── Message senders ──

	function send(message: Uint8Array) {
		if (websocket?.readyState === WebSocket.OPEN) {
			websocket.send(message);
		}
	}

	// ── Doc + awareness handlers ──

	function handleDocUpdate(update: Uint8Array, origin: unknown) {
		if (origin === SYNC_ORIGIN) return;
		send(encodeSyncUpdate({ update }));
		localVersion++;
		// Debounce: probe after a 100ms quiet period rather than per-update, so
		// a burst of edits costs one SYNC_STATUS round-trip, not N.
		if (syncStatusTimer) clearTimeout(syncStatusTimer);
		syncStatusTimer = setTimeout(() => {
			send(encodeSyncStatus(localVersion));
			syncStatusTimer = null;
		}, 100);
	}

	function handleAwarenessUpdate(
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) {
		if (origin === SYNC_ORIGIN) return;
		if (!awareness) return;
		const changedClients = added.concat(updated).concat(removed);
		send(
			encodeAwareness({
				update: encodeAwarenessUpdate(awareness, changedClients),
			}),
		);
	}

	// ── Browser event handlers ──

	function handleOnline() {
		backoff.wake();
	}

	function handleOffline() {
		websocket?.close();
	}

	function handleVisibilityChange() {
		if (document.visibilityState !== 'visible') return;
		// Wakeup ping after the tab returns to foreground. The server is
		// expected to echo any inbound message via `liveness.touch()`, so
		// this also probes "is the wire actually responsive?" beyond what
		// the 60s PING_INTERVAL_MS keepalive covers. If the server doesn't
		// echo strings, focus events become a no-op for liveness — the
		// 90s LIVENESS_TIMEOUT_MS still catches a dead wire eventually.
		if (websocket?.readyState === WebSocket.OPEN) {
			websocket.send('ping');
		}
	}

	function manageWindowListeners(action: 'add' | 'remove') {
		const method =
			action === 'add' ? 'addEventListener' : 'removeEventListener';
		if (typeof window !== 'undefined') {
			window[method]('offline', handleOffline);
			window[method]('online', handleOnline);
		}
		if (typeof document !== 'undefined') {
			document[method]('visibilitychange', handleVisibilityChange);
		}
	}

	// ── Supervisor loop ──

	async function runLoop(signal: AbortSignal) {
		let lastError: SyncError | undefined;

		while (!signal.aborted && !permanentFailure) {
			// Pending RPCs from the previous connection will never resolve —
			// clear them before starting a new attempt.
			clearPendingRequests();

			status.set({ phase: 'connecting', retries: backoff.retries, lastError });

			let token: string | null = null;
			if (config.getToken) {
				try {
					token = await config.getToken();
				} catch (cause) {
					token = null;
					lastError = { type: 'auth', error: cause };
				}
				if (signal.aborted) break;
				// Recovered: a fresh token clears any prior auth error so the
				// 'connecting' status doesn't display a stale one.
				if (token && lastError?.type === 'auth') lastError = undefined;
			}
			if (requiresToken && !token) {
				lastError = lastError ?? {
					type: 'auth',
					error: new Error('No token available'),
				};
				status.set({
					phase: 'connecting',
					retries: backoff.retries,
					lastError,
				});
				await backoff.sleep(signal);
				continue;
			}

			const result = await attemptConnection(token, signal);
			if (signal.aborted) break;

			if (result === 'connected') {
				backoff.reset();
				lastError = undefined;
			} else {
				lastError = { type: 'connection' };
			}

			if (!signal.aborted) {
				await backoff.sleep(signal);
			}
		}

		status.set(
			permanentFailure
				? { phase: 'failed', reason: permanentFailure }
				: { phase: 'offline' },
		);
	}

	async function attemptConnection(
		token: string | null,
		signal: AbortSignal,
	): Promise<'connected' | 'failed'> {
		const wsUrl = config.url;

		// Auth via WebSocket subprotocol, not `?token=`. Query strings land in
		// access logs, referrers, and browser history; the subprotocol header
		// does not. We offer two protocols: the main one (which the server
		// echoes back to complete the handshake) and a `bearer.<token>`
		// carrier (which the server consumes and never echoes).
		const subprotocols = [MAIN_SUBPROTOCOL];
		if (token) subprotocols.push(`${BEARER_SUBPROTOCOL_PREFIX}${token}`);
		const WebSocketConstructor =
			config.webSocketImpl ?? (globalThis.WebSocket as WebSocketImpl);
		const ws = new WebSocketConstructor(wsUrl, subprotocols);
		ws.binaryType = 'arraybuffer';
		websocket = ws;

		// Fresh connection → server has no memory of our prior counters.
		localVersion = 0;
		ackedVersion = 0;
		if (syncStatusTimer) {
			clearTimeout(syncStatusTimer);
			syncStatusTimer = null;
		}

		const { promise: openPromise, resolve: resolveOpen } =
			Promise.withResolvers<boolean>();
		const { promise: closePromise, resolve: resolveClose } =
			Promise.withResolvers<void>();
		let handshakeComplete = false;

		const liveness = createLivenessMonitor(ws);

		const connectTimeout = setTimeout(() => {
			if (ws.readyState === WebSocket.CONNECTING) ws.close();
		}, CONNECT_TIMEOUT_MS);

		// Cycle abort closes the in-flight socket so `closePromise` resolves
		// and the loop can iterate. Listener auto-detaches when this socket's
		// own close fires (we wire ws.onclose to call cleanupAbortListener).
		const onAbort = () => {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
		};
		const cleanupAbortListener = () => {
			signal.removeEventListener('abort', onAbort);
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}

		ws.onopen = () => {
			clearTimeout(connectTimeout);
			send(encodeSyncStep1({ doc: ydoc }));

			if (awareness && awareness.getLocalState() !== null) {
				send(
					encodeAwarenessStates({
						awareness,
						clients: [ydoc.clientID],
					}),
				);
			}

			liveness.start();
			resolveOpen(true);
		};

		ws.onclose = (event: CloseEvent) => {
			clearTimeout(connectTimeout);
			cleanupAbortListener();
			liveness.stop();
			if (awareness) {
				removeAwarenessStates(
					awareness,
					Array.from(awareness.getStates().keys()).filter(
						(client) => client !== ydoc.clientID,
					),
					SYNC_ORIGIN,
				);
			}
			const failure = parsePermanentFailure(event);
			if (failure) permanentFailure = failure;
			websocket = null;
			resolveOpen(false);
			resolveClose();
		};

		ws.onerror = () => {
			resolveOpen(false);
		};

		ws.onmessage = (event: MessageEvent) => {
			liveness.touch();
			if (typeof event.data === 'string') return;

			const data: Uint8Array = new Uint8Array(event.data);
			const decoder = decoding.createDecoder(data);
			const messageType = decoding.readVarUint(decoder);

			switch (messageType) {
				case MESSAGE_TYPE.SYNC: {
					const syncType = decoding.readVarUint(decoder) as SyncMessageType;
					const payload = decoding.readVarUint8Array(decoder);
					const response = handleSyncPayload({
						syncType,
						payload,
						doc: ydoc,
						origin: SYNC_ORIGIN,
					});
					if (response) {
						send(response);
					} else if (
						!handshakeComplete &&
						(syncType === SYNC_MESSAGE_TYPE.STEP2 ||
							syncType === SYNC_MESSAGE_TYPE.UPDATE)
					) {
						handshakeComplete = true;
						status.set({
							phase: 'connected',
							hasLocalChanges: localVersion > ackedVersion,
						});
					}
					break;
				}

				case MESSAGE_TYPE.AWARENESS: {
					if (awareness) {
						applyAwarenessUpdate(
							awareness,
							decoding.readVarUint8Array(decoder),
							SYNC_ORIGIN,
						);
					}
					break;
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					if (awareness) {
						send(
							encodeAwarenessStates({
								awareness,
								clients: Array.from(awareness.getStates().keys()),
							}),
						);
					}
					break;
				}

				case MESSAGE_TYPE.SYNC_STATUS: {
					const version = decoding.readVarUint(decoder);
					const prevHasChanges = localVersion > ackedVersion;
					ackedVersion = Math.max(ackedVersion, version);
					const nowHasChanges = localVersion > ackedVersion;
					if (prevHasChanges !== nowHasChanges && handshakeComplete) {
						status.set({
							phase: 'connected',
							hasLocalChanges: nowHasChanges,
						});
					}
					break;
				}

				case MESSAGE_TYPE.RPC: {
					const rpc = decodeRpcPayload(decoder);
					if (rpc.type === 'response') {
						const pending = pendingRequests.get(rpc.requestId);
						if (pending) {
							clearTimeout(pending.timer);
							pendingRequests.delete(rpc.requestId);
							// Trust-the-wire cast: the JSON payload is structurally a
							// Result, but decodeRpcPayload types it as the raw shape.
							pending.resolve(rpc.result as Result<unknown, unknown>);
						}
					} else if (rpc.type === 'request') {
						void handleRpcRequest(rpc);
					}
					break;
				}
			}
		};

		const opened = await openPromise;
		if (!opened || signal.aborted) {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
			await closePromise;
			return 'failed';
		}

		await closePromise;
		return handshakeComplete ? 'connected' : 'failed';
	}

	function ensureSupervisor() {
		if (masterController.signal.aborted) return;
		if (loopPromise) return;
		manageWindowListeners('add');
		const signal = cycleController.signal;
		loopPromise = runLoop(signal).finally(() => {
			loopPromise = null;
			// If `reconnect()` swapped in a fresh cycleController while we were
			// draining (e.g., a status subscriber called `reconnect()` from
			// inside `runLoop`'s synchronous tail), the new cycle won't have
			// started yet. Detect this and chain a fresh loop. Without this,
			// the reconnect's `ensureSupervisor` early-returned because
			// loopPromise was still set, and the supervisor would silently die.
			if (
				!masterController.signal.aborted &&
				!permanentFailure &&
				cycleController.signal !== signal &&
				!cycleController.signal.aborted
			) {
				ensureSupervisor();
			}
		});
	}

	function goOffline() {
		cycleController.abort();
		manageWindowListeners('remove');
		status.set({ phase: 'offline' });
	}

	// ── Attach listeners + start ──

	ydoc.on('updateV2', handleDocUpdate);
	if (awareness) {
		awareness.on('update', handleAwarenessUpdate);
	}

	// Gate the first connection on `waitFor` (typically idb.whenLoaded).
	// If `waitFor` rejects, log but still start: better to try syncing than
	// silently stay offline because persistence failed.
	void (async () => {
		try {
			await waitForPromise;
		} catch (cause) {
			log.warn(SyncSupervisorError.WaitForRejected({ cause }));
		}
		ensureSupervisor();
	})();

	// ── Teardown ──

	// `whenDisposed` must be a real barrier: it resolves only after the
	// supervisor loop has fully exited (which itself awaits `ws.onclose`) and
	// any still-open socket has hit CLOSED (or a 1s safety timeout elapses).
	// The earlier implementation resolved synchronously in `finally`, which
	// meant callers awaiting `whenDisposed` saw a socket still in CLOSING.
	ydoc.once('destroy', async () => {
		// Master abort cascades to cycleController (closes ws, wakes
		// backoff sleep, fires attemptConnection's abort listener).
		masterController.abort();
		// Reject `whenConnected` if dispose lands before the first handshake
		// (permanent failure: dead URL, denied auth). Callers awaiting it
		// would otherwise hang forever — the doc is gone, the promise must
		// settle. Attach a no-op catch BEFORE rejecting so the rejection
		// isn't unhandled when no consumer awaits.
		whenConnected.catch(() => {});
		settleConnected(() => {
			rejectConnected(
				new Error('[attachSync] doc destroyed before first handshake'),
			);
		});
		try {
			ydoc.off('updateV2', handleDocUpdate);
			if (awareness) {
				awareness.off('update', handleAwarenessUpdate);
			}
			const ws = websocket;
			clearPendingRequests();
			manageWindowListeners('remove');
			status.clear();
			if (loopPromise) await loopPromise;
			await waitForWsClose(ws, 1000, log);
		} finally {
			resolveDisposed();
		}
	});

	return {
		whenConnected,
		get status() {
			return status.get();
		},
		onStatusChange: status.subscribe,
		goOffline,
		reconnect() {
			if (masterController.signal.aborted) return;
			permanentFailure = null;
			cycleController.abort();
			cycleController = childOf(masterController.signal);
			backoff.reset();
			manageWindowListeners('add');
			ensureSupervisor();
		},
		whenDisposed,
		peers: () => (typedAwareness ? typedAwareness.peers() : new Map()),
		find(deviceId) {
			if (!typedAwareness) return undefined;
			const all = typedAwareness.peers();
			const sorted = [...all.keys()].sort((a, b) => a - b);
			for (const clientId of sorted) {
				const state = all.get(clientId)!;
				if (state.device.id === deviceId) {
					return { clientId, state };
				}
			}
			return undefined;
		},
		async waitForPeer(deviceId, { timeoutMs }) {
			if (!typedAwareness) {
				return PeerMiss.PeerMiss({
					peerTarget: deviceId,
					sawPeers: false,
					waitMs: timeoutMs,
					emptyReason: describeOfflineReason(status.get()),
				});
			}

			let sawPeers = false;
			const tryMatch = (): FoundPeer | undefined => {
				const all = typedAwareness.peers();
				if (all.size > 0) sawPeers = true;
				const sorted = [...all.keys()].sort((a, b) => a - b);
				for (const clientId of sorted) {
					const state = all.get(clientId)!;
					if (state.device.id === deviceId) return { clientId, state };
				}
				return undefined;
			};

			const initial = tryMatch();
			if (initial) return Ok(initial);

			if (timeoutMs <= 0) {
				return PeerMiss.PeerMiss({
					peerTarget: deviceId,
					sawPeers,
					waitMs: timeoutMs,
					emptyReason: describeOfflineReason(status.get()),
				});
			}

			return new Promise((resolve) => {
				const stop = typedAwareness.observe(() => {
					const hit = tryMatch();
					if (hit) {
						clearTimeout(timer);
						stop();
						resolve(Ok(hit));
					}
				});
				const timer = setTimeout(() => {
					stop();
					resolve(
						PeerMiss.PeerMiss({
							peerTarget: deviceId,
							sawPeers,
							waitMs: timeoutMs,
							emptyReason: describeOfflineReason(status.get()),
						}),
					);
				}, timeoutMs);
			});
		},
		observe(callback) {
			if (!typedAwareness) return () => {};
			return typedAwareness.observe(callback);
		},
		raw: { awareness },
		async rpc<
			TMap extends RpcActionMap = DefaultRpcMap,
			TAction extends string & keyof TMap = string & keyof TMap,
		>(
			target: number,
			action: TAction,
			input?: TMap[TAction]['input'],
			options?: { timeout?: number },
		): Promise<Result<TMap[TAction]['output'], RpcError>> {
			if (target === ydoc.clientID) {
				return RpcError.ActionFailed({
					action,
					cause: 'Cannot RPC to self — call the action directly',
				});
			}

			// Reject post-dispose calls immediately. Without this, a late
			// rpc() would register a setTimeout(timeoutMs) entry in
			// pendingRequests that nothing clears, leaking the timer until
			// the default 5s timeout fires.
			if (masterController.signal.aborted) return RpcError.Disconnected();

			// Short-circuit when the socket is in CONNECTING/CLOSING/CLOSED.
			// `send()` would silently no-op the request bytes, leaving the
			// pendingRequests entry to wait the full timeout for a phantom
			// response. Better to fail fast and let the caller decide whether
			// to retry once we're back online.
			if (websocket?.readyState !== WebSocket.OPEN) {
				return RpcError.Disconnected();
			}

			const timeoutMs = options?.timeout ?? DEFAULT_RPC_TIMEOUT_MS;

			return new Promise((resolve) => {
				const requestId = nextRequestId++;
				send(
					encodeRpcRequest({
						requestId,
						targetClientId: target,
						requesterClientId: ydoc.clientID,
						action,
						input,
					}),
				);

				const timer = setTimeout(() => {
					pendingRequests.delete(requestId);
					resolve(RpcError.Timeout({ ms: timeoutMs }));
				}, timeoutMs);

				pendingRequests.set(requestId, {
					action,
					resolve: (result) => {
						clearTimeout(timer);
						if (isRpcError(result.error)) {
							resolve(Err(result.error));
						} else if (result.error != null) {
							resolve(
								RpcError.ActionFailed({
									action,
									cause: result.error,
								}),
							);
						} else {
							// Trust-the-wire cast: both RPC sides are in the same monorepo.
							// Same pattern as tRPC/Eden Treaty — structural type safety, not
							// runtime. Unavoidable without output schemas on actions.
							resolve(Ok(result.data as TMap[TAction]['output']));
						}
					},
					timer,
				});
			});
		},
	};
}

// ============================================================================
// Helpers
// ============================================================================

function createStatusEmitter<T>(initial: T) {
	let current = initial;
	const listeners = new Set<(value: T) => void>();
	return {
		get() {
			return current;
		},
		set(value: T) {
			current = value;
			for (const listener of listeners) listener(value);
		},
		subscribe(listener: (value: T) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clear() {
			listeners.clear();
		},
	};
}

function createLivenessMonitor(ws: SyncWebSocket) {
	let pingInterval: ReturnType<typeof setInterval> | null = null;
	let livenessInterval: ReturnType<typeof setInterval> | null = null;
	let lastMessageTime = 0;

	function stop() {
		if (pingInterval) clearInterval(pingInterval);
		if (livenessInterval) clearInterval(livenessInterval);
	}

	return {
		start() {
			stop();
			lastMessageTime = Date.now();

			pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send('ping');
			}, PING_INTERVAL_MS);

			livenessInterval = setInterval(() => {
				if (Date.now() - lastMessageTime > LIVENESS_TIMEOUT_MS) {
					ws.close();
				}
			}, LIVENESS_CHECK_INTERVAL_MS);
		},
		touch() {
			lastMessageTime = Date.now();
		},
		stop,
	};
}

/**
 * Await a WebSocket's `close` event, with a timeout safeguard.
 *
 * Resolves immediately if the socket is null or already CLOSED. Otherwise
 * attaches a one-shot `close` listener and races it against `timeoutMs` —
 * a misbehaving server that never sends a close frame shouldn't block
 * teardown indefinitely.
 */
function waitForWsClose(
	ws: SyncWebSocket | null,
	timeoutMs: number,
	log: Logger,
): Promise<void> {
	if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const onClose = () => {
			clearTimeout(timer);
			resolve();
		};
		ws.addEventListener('close', onClose, { once: true });
		const timer = setTimeout(() => {
			ws.removeEventListener('close', onClose);
			log.warn(SyncSupervisorError.CloseTimeout({ timeoutMs }));
			resolve();
		}, timeoutMs);
	});
}

function createBackoff() {
	let retries = 0;
	let externalWake: (() => void) | null = null;

	return {
		/**
		 * Sleep for exponentially-jittered backoff. Returns early on `signal`
		 * abort or on an explicit `wake()` (e.g. window 'online' event). Never
		 * throws — callers re-check `signal.aborted` after.
		 */
		async sleep(signal: AbortSignal): Promise<void> {
			const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
			const ms = exponential * (0.5 + Math.random() * 0.5);
			retries += 1;

			if (signal.aborted) return;

			return new Promise<void>((resolve) => {
				const cleanup = () => {
					clearTimeout(handle);
					signal.removeEventListener('abort', onAbort);
					externalWake = null;
				};
				const handle = setTimeout(() => {
					cleanup();
					resolve();
				}, ms);
				const onAbort = () => {
					cleanup();
					resolve();
				};
				signal.addEventListener('abort', onAbort, { once: true });
				externalWake = () => {
					cleanup();
					resolve();
				};
			});
		},
		/** External wake (e.g. window 'online' event) — short-circuits the sleep without aborting the cycle. */
		wake() {
			externalWake?.();
		},
		reset() {
			retries = 0;
		},
		get retries() {
			return retries;
		},
	};
}

/**
 * Build an `AbortController` whose signal is aborted whenever `parent` is.
 * Aborting the child does NOT abort the parent. The parent→child listener
 * self-cleans when the child is aborted first via the `signal` option.
 */
function childOf(parent: AbortSignal): AbortController {
	const child = new AbortController();
	if (parent.aborted) {
		child.abort(parent.reason);
	} else {
		parent.addEventListener('abort', () => child.abort(parent.reason), {
			once: true,
			signal: child.signal,
		});
	}
	return child;
}
