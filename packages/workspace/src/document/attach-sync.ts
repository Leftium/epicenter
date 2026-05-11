/// <reference lib="dom" />

import {
	BEARER_SUBPROTOCOL_PREFIX,
	decodeRpcPayload,
	encodeAwareness,
	encodeAwarenessStates,
	encodeRpcRequest,
	encodeRpcResponse,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	isRpcError,
	isTransportOrigin,
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
import type {
	AwarenessAttachment,
	AwarenessSchema,
} from './attach-awareness.js';

/**
 * Minimal Y.Doc sync attachment: connects a Y.Doc to a WebSocket sync server.
 *
 * This is a low-level primitive for `packages/document`. It handles the
 * Y.Doc sync protocol (STEP1/STEP2/UPDATE), supervisor loop with exponential
 * backoff, liveness detection, and graceful shutdown.
 *
 * **Not included** (workspace-layer concerns):
 * - BroadcastChannel cross-tab sync (separate `attachBroadcastChannel` helper)
 * - Peer directory helpers over an attached awareness state
 * - Peer RPC (`sync.attachRpc(actions)`)
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

export type SyncError = { type: 'connection' };

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
	| { phase: 'connected' }
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
	PermanentClose: ({
		closeCode,
		reason,
	}: {
		closeCode: number;
		reason: SyncFailedReason;
	}) => ({
		message: `[attachSync] server sent permanent close ${closeCode}: ${reason.code}`,
		closeCode,
		reason,
	}),
});
export type SyncSupervisorError = InferErrors<typeof SyncSupervisorError>;

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
	whenConnected: Promise<void>;
	/** Current connection status. */
	readonly status: SyncStatus;
	/** Subscribe to status changes. Returns unsubscribe function. */
	onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
	/** Force a fresh connection with new credentials (supervisor restarts iteration). */
	reconnect(): void;
	/**
	 * Resolves after `ydoc.destroy()` fires the cascade, the supervisor loop exits,
	 * and any open websocket closes or reaches the safety timeout.
	 */
	whenDisposed: Promise<void>;
	attachRpc(actions: RpcActionSource): SyncRpcAttachment;
};

export type RpcActionSource = Record<string, unknown>;

export type SyncRpcAttachment = {
	rpc<
		TMap extends RpcActionMap = DefaultRpcMap,
		TAction extends string & keyof TMap = string & keyof TMap,
	>(
		target: number,
		action: TAction,
		input?: TMap[TAction]['input'],
		options?: RemoteCallOptions,
	): Promise<Result<TMap[TAction]['output'], RpcError>>;
};

export type SyncAttachmentConfig = {
	/**
	 * WebSocket URL for the room. Must use ws:/wss:. Use `toWsUrl()` to convert
	 * an HTTP URL. Typically interpolates `ydoc.guid` into the path.
	 */
	url: string;
	/**
	 * Gate the first connection attempt on another promise, typically
	 * `attachIndexedDb(ydoc).whenLoaded`. Without this, the supervisor
	 * connects before local state hydrates and the handshake transfers the
	 * full document instead of just the delta.
	 */
	waitFor?: Promise<unknown>;
	/**
	 * Optional bearer-token augmentation for the WebSocket handshake.
	 *
	 * When omitted, `attachSync` opens a normal sync WebSocket with only the
	 * main Epicenter subprotocol. Browser cookie auth can still authenticate
	 * that upgrade if the API origin has a valid session cookie.
	 *
	 * When provided, the getter is called on every reconnect so token rotation
	 * is observed. A string return adds `bearer.<token>` to the subprotocol
	 * list. A null return sends no bearer subprotocol for this attempt. Browser
	 * cookie auth can still authenticate that upgrade through the cookie jar.
	 */
	bearerToken?: () => string | null;
	/**
	 * Logger for background supervisor failures (waitFor rejections, socket
	 * close timeouts). Defaults to a console-backed logger with source
	 * `attachSync`.
	 */
	log?: Logger;
	/**
	 * Optional awareness attachment to transport over the same WebSocket.
	 * When omitted, document sync works without creating awareness state.
	 */
	awareness?: AwarenessAttachment<AwarenessSchema>;
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
	ydoc: Y.Doc,
	config: SyncAttachmentConfig,
): SyncAttachment {
	let rpcActions: Record<string, unknown> | null = null;
	const awareness = config.awareness?.raw ?? null;

	const waitForPromise = config.waitFor;

	const log = config.log ?? createLogger('attachSync');

	const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });
	function setStatus(next: SyncStatus) {
		const previous = status.get();
		status.set(next);
		if (previous.phase === next.phase) return;
		switch (next.phase) {
			case 'connected':
				log.info('sync connected', { phase: next.phase, docGuid: ydoc.guid });
				break;
			case 'failed':
				log.info('sync failed', {
					phase: next.phase,
					docGuid: ydoc.guid,
					reason: next.reason,
				});
				break;
			case 'offline':
				log.info('sync offline', { phase: next.phase, docGuid: ydoc.guid });
				break;
		}
	}

	// `whenConnected` settles once: resolved when the first successful handshake
	// lands (STEP2/UPDATE), rejected on permanent server auth failure (close
	// 4401) or on doc destroy before the first handshake. Settled directly at
	// each transition site below (no internal status subscription).
	const connected = createOneShotPromise<void>();
	const backoff = createBackoff();

	/**
	 * Cancellation hierarchy:
	 *
	 *   masterController: aborts on doc.destroy(); kills everything
	 *      cycleController: aborts on reconnect();
	 *                       kills the current supervisor iteration
	 *
	 * `cycleController` is replaced (not just re-aborted) by `reconnect()` so
	 * the new connection cycle has a fresh signal unrelated to the old one.
	 * Aborting an already-aborted controller is a no-op, which makes repeated
	 * reconnects structurally safe. The supervisor reads `cycleController.signal`
	 * fresh at the top of each iteration; aborting the old one wakes a parked
	 * supervisor and the next iteration picks up the replacement.
	 */
	const masterController = new AbortController();
	let cycleController: AbortController = childOf(masterController.signal);

	/** Current WebSocket instance, or null. */
	let websocket: WebSocket | null = null;

	// RPC state.
	//
	// `pendingRequests` tracks outbound RPCs awaiting a response. Cleared in
	// `ws.onclose`: the next connection is a fresh server-side context, so any
	// in-flight request from the prior connection will never resolve, and the
	// caller deserves an immediate `Disconnected` instead of a timeout.
	const pendingRequests = new Map<
		number,
		{
			action: string;
			resolve: (result: Result<unknown, unknown>) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let nextRequestId = 0;

	function clearPendingRequests() {
		const disconnected = RpcError.Disconnected();
		for (const [, pending] of pendingRequests) {
			clearTimeout(pending.timer);
			pending.resolve(disconnected);
		}
		pendingRequests.clear();
	}

	/**
	 * Handle an inbound RPC request: resolve against the attached RPC action
	 * tree and send the response back to the requester.
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
		const target = rpcActions
			? resolveActionPath(rpcActions, rpc.action)
			: null;
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

	// ── Doc handlers ──

	function handleDocUpdate(update: Uint8Array, origin: unknown) {
		if (isTransportOrigin(origin)) return;
		send(encodeSyncUpdate({ update }));
	}

	function handleAwarenessUpdate(
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) {
		if (!awareness || origin === SYNC_ORIGIN) return;
		const changedClients = added.concat(updated).concat(removed);
		send(
			encodeAwareness({
				update: encodeAwarenessUpdate(awareness, changedClients),
			}),
		);
	}

	function handleRemoteAwarenessUpdate(update: Uint8Array) {
		if (!awareness) return;
		applyAwarenessUpdate(awareness, update, SYNC_ORIGIN);
	}

	function sendLocalAwarenessState() {
		if (!awareness || awareness.getLocalState() === null) return;
		send(
			encodeAwarenessStates({
				awareness,
				clients: [ydoc.clientID],
			}),
		);
	}

	function sendKnownAwarenessStates() {
		if (!awareness) return;
		send(
			encodeAwarenessStates({
				awareness,
				clients: Array.from(awareness.getStates().keys()),
			}),
		);
	}

	function removeRemoteAwarenessStates() {
		if (!awareness) return;
		const remoteClientIds = Array.from(awareness.getStates().keys()).filter(
			(clientId) => clientId !== ydoc.clientID,
		);
		if (remoteClientIds.length === 0) return;
		removeAwarenessStates(awareness, remoteClientIds, SYNC_ORIGIN);
	}

	// Browser online/offline/visibility wakeups. Auto-removed when the master
	// signal aborts (i.e., on doc destroy). All three are no-ops when the
	// supervisor isn't actively trying to connect, so attaching at construction
	// time before `waitFor` settles is harmless.
	if (typeof window !== 'undefined') {
		window.addEventListener('online', () => backoff.wake(), {
			signal: masterController.signal,
		});
		window.addEventListener('offline', () => websocket?.close(), {
			signal: masterController.signal,
		});
	}
	if (typeof document !== 'undefined') {
		// Visibility ping probes "is the wire responsive?" when a tab returns
		// to foreground, beyond what the 60s PING_INTERVAL_MS keepalive covers.
		// If the server doesn't echo strings, this is a no-op; the 90s
		// LIVENESS_TIMEOUT_MS still catches a dead wire eventually.
		document.addEventListener(
			'visibilitychange',
			() => {
				if (document.visibilityState !== 'visible') return;
				if (websocket?.readyState === WebSocket.OPEN) websocket.send('ping');
			},
			{ signal: masterController.signal },
		);
	}

	async function attemptConnection(
		signal: AbortSignal,
	): Promise<'connected' | 'failed'> {
		let ws: WebSocket;
		try {
			const token = config.bearerToken?.() ?? null;
			const protocols = token
				? [MAIN_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${token}`]
				: [MAIN_SUBPROTOCOL];
			ws = new WebSocket(config.url, protocols);
		} catch {
			return 'failed';
		}
		ws.binaryType = 'arraybuffer';
		websocket = ws;

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

			sendLocalAwarenessState();

			liveness.start();
			resolveOpen(true);
		};

		ws.onclose = (event: CloseEvent) => {
			clearTimeout(connectTimeout);
			cleanupAbortListener();
			liveness.stop();
			removeRemoteAwarenessStates();
			clearPendingRequests();
			const failure = parsePermanentFailure(event);
			if (failure) {
				setStatus({ phase: 'failed', reason: failure });
				connected.reject(
					SyncFailedError.AuthRejected({ code: failure.code }).error,
				);
				log.warn(
					SyncSupervisorError.PermanentClose({
						closeCode: event.code,
						reason: failure,
					}),
				);
			}
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
						setStatus({ phase: 'connected' });
						connected.resolve();
					}
					break;
				}

				case MESSAGE_TYPE.AWARENESS: {
					handleRemoteAwarenessUpdate(decoding.readVarUint8Array(decoder));
					break;
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					sendKnownAwarenessStates();
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

	// One supervisor task, started after `waitFor` settles, lives until master
	// abort. Each iteration reads `cycleController.signal` fresh so `reconnect()`
	// just swaps the controller and aborts the old; the supervisor wakes
	// (either from `attemptConnection`, `backoff.sleep`, or the parked-on-failed
	// `waitForAbort`) and the next iteration picks up the replacement.
	const supervisorPromise = (async () => {
		// Race `waitFor` against doc destroy so we don't hang forever if a
		// caller passes a never-settling barrier and then destroys the doc.
		// The `.catch` on `waitForPromise` is unconditional so a late rejection
		// (after the race has already resolved via abort) does not surface as an
		// unhandled rejection.
		if (waitForPromise) {
			const settled = Promise.resolve(waitForPromise).catch((cause) => {
				if (masterController.signal.aborted) return;
				log.warn(SyncSupervisorError.WaitForRejected({ cause }));
			});
			await Promise.race([settled, waitForAbort(masterController.signal)]);
		}
		if (masterController.signal.aborted) return;

		let lastError: SyncError | undefined;

		try {
			while (!masterController.signal.aborted) {
				// In `failed`, park until reconnect aborts the cycle to wake us.
				// `reconnect` swaps `cycleController` first, then aborts the old
				// one, so on wake we read the fresh signal next iteration.
				if (status.get().phase === 'failed') {
					await waitForAbort(cycleController.signal);
					continue;
				}

				const signal = cycleController.signal;

				setStatus({
					phase: 'connecting',
					retries: backoff.retries,
					lastError,
				});

				const result = await attemptConnection(signal);
				if (masterController.signal.aborted) break;

				if (result === 'connected') {
					backoff.reset();
					lastError = undefined;
				} else {
					lastError = { type: 'connection' };
				}

				if (
					!masterController.signal.aborted &&
					status.get().phase !== 'failed' &&
					!signal.aborted
				) {
					await backoff.sleep(signal);
				}
			}
		} finally {
			if (status.get().phase !== 'failed') setStatus({ phase: 'offline' });
			log.info('sync supervisor exited', {
				phase: status.get().phase,
				docGuid: ydoc.guid,
			});
		}
	})();

	function reconnect() {
		if (masterController.signal.aborted) return;
		// Clear the terminal `failed` phase so the supervisor unparks and tries
		// again. The status emit also notifies external subscribers.
		if (status.get().phase === 'failed') setStatus({ phase: 'offline' });
		const old = cycleController;
		cycleController = childOf(masterController.signal);
		backoff.reset();
		old.abort();
	}

	// ── Attach listeners + teardown ──

	ydoc.on('updateV2', handleDocUpdate);
	awareness?.on('update', handleAwarenessUpdate);

	// `whenDisposed` resolves only after the supervisor loop has fully exited
	// and any still-open socket has hit CLOSED, or the safety timeout elapses.
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		try {
			// Master abort cascades to cycleController (closes ws, wakes
			// backoff sleep, fires attemptConnection's abort listener, and
			// unparks the supervisor if it was waiting in the `failed` phase).
			masterController.abort();
			// Reject `whenConnected` if dispose lands before the first handshake
			// (permanent failure: dead URL, denied auth, dispose during outage).
			// Callers awaiting it would otherwise hang forever.
			connected.reject(
				new Error('[attachSync] doc destroyed before first handshake'),
			);
			ydoc.off('updateV2', handleDocUpdate);
			awareness?.off('update', handleAwarenessUpdate);
			const ws = websocket;
			status.clear();
			await supervisorPromise;
			await waitForWsClose(ws, 1000, log);
		} finally {
			resolveDisposed();
		}
	});

	return {
		whenConnected: connected.promise,
		get status() {
			return status.get();
		},
		onStatusChange: status.subscribe,
		reconnect,
		whenDisposed,
		attachRpc(userActions) {
			if (rpcActions) throw new Error('[attachSync] RPC already attached');
			if ('system' in userActions) {
				throw new Error(
					"User actions cannot define the 'system.*' namespace. It is reserved for runtime meta operations.",
				);
			}
			const systemActions: SystemActions = Object.freeze({
				describe: defineQuery({
					handler: () => describeActions(userActions),
				}),
			});
			rpcActions = Object.freeze({
				...userActions,
				system: systemActions,
			});
			return {
				rpc: async <
					TMap extends RpcActionMap = DefaultRpcMap,
					TAction extends string & keyof TMap = string & keyof TMap,
				>(
					target: number,
					action: TAction,
					input?: TMap[TAction]['input'],
					{ timeout = DEFAULT_RPC_TIMEOUT_MS }: { timeout?: number } = {},
				): Promise<Result<TMap[TAction]['output'], RpcError>> => {
					if (target === ydoc.clientID) {
						return RpcError.ActionFailed({
							action,
							cause: 'Cannot RPC to self, call the action directly',
						});
					}

					if (masterController.signal.aborted) return RpcError.Disconnected();

					if (websocket?.readyState !== WebSocket.OPEN) {
						return RpcError.Disconnected();
					}

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
							resolve(RpcError.Timeout({ ms: timeout }));
						}, timeout);

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
									resolve(Ok(result.data as TMap[TAction]['output']));
								}
							},
							timer,
						});
					});
				},
			};
		},
	};
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * One-shot promise with idempotent `resolve`/`reject`. Pre-attaches a no-op
 * `.catch` so a rejection without a consumer (e.g., `whenConnected` rejected
 * by permanent failure or dispose-before-handshake when no caller awaits it)
 * does not surface as an unhandled rejection.
 */
function createOneShotPromise<T>() {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	promise.catch(() => {});
	let settled = false;
	return {
		promise,
		resolve(value: T) {
			if (settled) return;
			settled = true;
			resolve(value);
		},
		reject(error: unknown) {
			if (settled) return;
			settled = true;
			reject(error);
		},
	};
}

/** Resolves when the signal aborts (or immediately if already aborted). */
function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

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

function createLivenessMonitor(ws: WebSocket) {
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
 * attaches a one-shot `close` listener and races it against `timeoutMs`.
 * A misbehaving server that never sends a close frame shouldn't block
 * teardown indefinitely.
 */
function waitForWsClose(
	ws: WebSocket | null,
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
		 * throws. Callers re-check `signal.aborted` after.
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
		/** External wake (e.g. window 'online' event): short-circuits the sleep without aborting the cycle. */
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
