/// <reference lib="dom" />

import {
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
	MESSAGE_TYPE,
	RpcError,
	SYNC_MESSAGE_TYPE,
	SYNC_ORIGIN,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import type { Result } from 'wellcrafted/result';
import { tryAsync } from 'wellcrafted/result';
import type { Awareness } from 'y-protocols/awareness';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { DefaultRpcMap, RpcActionMap } from '../rpc/types.js';

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
 * Register persistence (`attachIndexedDb`) first and pass its `whenLocalReady`
 * as `waitFor` so the supervisor connects only after local state hydrates —
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

export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; attempt: number; lastError?: SyncError }
	| { phase: 'connected'; hasLocalChanges: boolean };

export type { DefaultRpcMap, RpcActionMap } from '../rpc/types.js';

/**
 * Inbound RPC dispatcher provided by the caller.
 *
 * Return a Result-ish shape: `{ data, error }` where `error` is an RpcError
 * payload (or any serializable error) or null. `action` is a dot-path string
 * (e.g. `'tabs.close'`).
 *
 * Defined here (not imported from `@epicenter/workspace`) to avoid a circular
 * dep — `attachSync` stays at the primitive layer and delegates action lookup
 * and invocation to the caller.
 */
export type RpcDispatch = (
	action: string,
	input: unknown,
) => Promise<{ data: unknown; error: unknown }>;

/**
 * Optional RPC feature block on the config.
 *
 * When omitted, `attachSync` responds to inbound RPC requests with
 * `RpcError.ActionNotFound` — remote callers receive a typed error rather
 * than a timeout.
 */
export type RpcConfig = {
	dispatch: RpcDispatch;
};

export type SyncAttachment = {
	/**
	 * Resolves after the WebSocket handshake completes and the first sync
	 * exchange finishes. Unlike `y-indexeddb`'s `whenSynced`, this is a
	 * real "transport established, initial state reconciled" guarantee.
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
	reconnect: () => void;
	/**
	 * Resolves after the ydoc is destroyed and the websocket teardown completes.
	 * Named symmetrically with `whenConnected` — both are promises.
	 */
	whenDisposed: Promise<void>;
	/**
	 * Invoke an action on a remote peer in this room.
	 *
	 * Pass a type map (e.g. from workspace's `InferRpcMap`) for full type
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
		options?: { timeout?: number },
	): Promise<Result<TMap[TAction]['output'], RpcError>>;
};

export type SyncAttachmentConfig = {
	/**
	 * WebSocket URL for the room. Receives the Y.Doc's GUID. Must use ws:/wss:.
	 * Use `toWsUrl()` to convert an HTTP URL.
	 */
	url: (docId: string) => string;
	/**
	 * Token fetcher for authenticated mode. Called fresh on each connect attempt —
	 * reconnect() triggers a new token fetch automatically.
	 */
	getToken?: (docId: string) => Promise<string | null>;
	/**
	 * Gate the first connection attempt on another promise (typically
	 * `attachIndexedDb(ydoc).whenLoaded`). Without this, the supervisor
	 * connects before local state hydrates and the handshake transfers the
	 * full document instead of just the delta.
	 */
	waitFor?: Promise<unknown>;
	/**
	 * Optional awareness instance. When provided, the attachment syncs presence
	 * state across peers and emits/consumes AWARENESS messages. Per-row content
	 * docs typically skip this; workspace-level docs provide it.
	 */
	awareness?: Awareness;
	/**
	 * Optional inbound RPC handler. When provided, incoming RPC requests are
	 * forwarded to `dispatch(action, input)`; when omitted, `attachSync`
	 * responds with `RpcError.ActionNotFound`.
	 *
	 * Outbound RPC (the `rpc()` method on the attachment) works regardless
	 * of whether this is set.
	 */
	rpc?: RpcConfig;
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
	const docId = ydoc.guid;
	const getToken = config.getToken ? () => config.getToken!(docId) : undefined;
	const awareness = config.awareness;

	const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });
	const { promise: whenConnected, resolve: resolveConnected } =
		Promise.withResolvers<void>();
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	const { promise: whenSupervisorExited, resolve: resolveSupervisorExited } =
		Promise.withResolvers<void>();
	const backoff = createBackoff();

	/** User intent: should we be connected? */
	let desired: 'online' | 'offline' = 'offline';

	/**
	 * Monotonic counter bumped by goOffline() and reconnect(). The supervisor
	 * loop captures this at the top of each iteration and `continue`s when the
	 * snapshot no longer matches — restarting with a fresh token.
	 */
	let runId = 0;

	/** Current WebSocket instance, or null. */
	let websocket: WebSocket | null = null;

	/** Gate: flip to true once supervisor exits; prevents double-teardown. */
	let torn = false;

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
			resolve: (result: { data: unknown; error: unknown }) => void;
			timer: ReturnType<typeof setTimeout>;
		}
	>();
	let nextRequestId = 0;

	/** Resolve all pending RPC requests with Disconnected and clear state. */
	function clearPendingRequests() {
		const { error } = RpcError.Disconnected();
		for (const [, pending] of pendingRequests) {
			clearTimeout(pending.timer);
			pending.resolve({ data: null, error });
		}
		pendingRequests.clear();
		nextRequestId = 0;
	}

	/**
	 * Handle an inbound RPC request: delegate action lookup to the caller
	 * via `config.rpc.dispatch`, and send the response back to the requester.
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
		const sendResponse = (result: { data: unknown; error: unknown }) =>
			send(
				encodeRpcResponse({
					requestId: rpc.requestId,
					requesterClientId: rpc.requesterClientId,
					result,
				}),
			);

		if (!config.rpc) {
			sendResponse({
				data: null,
				error: RpcError.ActionNotFound({ action: rpc.action }).error,
			});
			return;
		}

		const { data, error } = await tryAsync({
			try: () => config.rpc!.dispatch(rpc.action, rpc.input),
			catch: (err) =>
				RpcError.ActionFailed({ action: rpc.action, cause: err }),
		});

		if (error) {
			sendResponse({ data: null, error });
			return;
		}
		// dispatch returns `{ data, error }` directly — forward it unchanged.
		sendResponse(data as { data: unknown; error: unknown });
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

	async function runLoop() {
		let attempt = 0;
		let lastError: SyncError | undefined;

		while (desired === 'online') {
			const myRunId = runId;

			// Pending RPCs from the previous connection will never resolve —
			// clear them before starting a new attempt.
			clearPendingRequests();

			status.set({ phase: 'connecting', attempt, lastError });

			let token: string | null = null;
			if (getToken) {
				try {
					token = await getToken();
					if (!token) throw new Error('No token available');
				} catch (e) {
					if (runId !== myRunId) {
						attempt = 0;
						lastError = undefined;
						continue;
					}
					lastError = { type: 'auth', error: e };
					status.set({ phase: 'connecting', attempt, lastError });
					await backoff.sleep();
					if (runId !== myRunId) {
						attempt = 0;
						lastError = undefined;
						continue;
					}
					attempt += 1;
					continue;
				}
			}

			if (runId !== myRunId) {
				attempt = 0;
				lastError = undefined;
				continue;
			}

			const result = await attemptConnection(token, myRunId);

			if (runId !== myRunId) {
				attempt = 0;
				lastError = undefined;
				continue;
			}

			if (result === 'connected') {
				backoff.reset();
				lastError = undefined;
			} else {
				lastError = { type: 'connection' };
			}

			if (desired === 'online') {
				attempt += 1;
				status.set({ phase: 'connecting', attempt, lastError });
				await backoff.sleep();
				if (runId !== myRunId) {
					attempt = 0;
					lastError = undefined;
				}
			}
		}

		status.set({ phase: 'offline' });
	}

	async function attemptConnection(
		token: string | null,
		myRunId: number,
	): Promise<'connected' | 'failed' | 'cancelled'> {
		let wsUrl = config.url(docId);
		if (token) {
			const parsed = new URL(wsUrl);
			parsed.searchParams.set('token', token);
			wsUrl = parsed.toString();
		}

		const ws = new WebSocket(wsUrl);
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

		ws.onclose = () => {
			clearTimeout(connectTimeout);
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
						resolveConnected();
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
							pending.resolve(rpc.result);
						}
					} else if (rpc.type === 'request') {
						void handleRpcRequest(rpc);
					}
					break;
				}
			}
		};

		const opened = await openPromise;
		if (!opened || runId !== myRunId) {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
			await closePromise;
			return runId !== myRunId ? 'cancelled' : 'failed';
		}

		await closePromise;
		return handshakeComplete ? 'connected' : 'failed';
	}

	function goOffline() {
		desired = 'offline';
		runId++;
		backoff.wake();
		manageWindowListeners('remove');
		websocket?.close();
		status.set({ phase: 'offline' });
	}

	// ── Attach listeners + start ──

	ydoc.on('updateV2', handleDocUpdate);
	if (awareness) {
		awareness.on('update', handleAwarenessUpdate);
	}

	// Gate the first connection on `waitFor` (typically idb.whenLocalReady).
	// If `waitFor` rejects, log but still start — better to try syncing than
	// silently stay offline because persistence failed.
	void (async () => {
		try {
			await config.waitFor;
		} catch (e) {
			console.warn('[attachSync] waitFor rejected; starting sync anyway', e);
		}
		if (torn) {
			resolveSupervisorExited();
			return;
		}
		desired = 'online';
		manageWindowListeners('add');
		try {
			await runLoop();
		} finally {
			resolveSupervisorExited();
		}
	})();

	// ── Teardown ──

	// `whenDisposed` must be a real barrier: it resolves only after the
	// supervisor loop has fully exited (which itself awaits `ws.onclose`) and
	// any still-open socket has hit CLOSED (or a 1s safety timeout elapses).
	// The earlier implementation resolved synchronously in `finally`, which
	// meant callers awaiting `whenDisposed` saw a socket still in CLOSING.
	ydoc.once('destroy', async () => {
		torn = true;
		try {
			ydoc.off('updateV2', handleDocUpdate);
			if (awareness) {
				awareness.off('update', handleAwarenessUpdate);
			}
			const ws = websocket;
			clearPendingRequests();
			goOffline();
			status.clear();
			await whenSupervisorExited;
			await waitForWsClose(ws, 1000);
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
		reconnect() {
			if (desired !== 'online') return;
			runId++;
			backoff.reset();
			backoff.wake();
			websocket?.close();
		},
		whenDisposed,
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
							resolve({ data: null, error: result.error });
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
							resolve({
								data: result.data as TMap[TAction]['output'],
								error: null,
							});
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
 * attaches a one-shot `close` listener and races it against `timeoutMs` —
 * a misbehaving server that never sends a close frame shouldn't block
 * teardown indefinitely.
 */
function waitForWsClose(
	ws: WebSocket | null,
	timeoutMs: number,
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
			console.warn(
				`[attachSync] WebSocket did not fire onclose within ${timeoutMs}ms; resolving whenDisposed anyway`,
			);
			resolve();
		}, timeoutMs);
	});
}

function createBackoff() {
	let retries = 0;
	let sleeper: { promise: Promise<void>; wake(): void } | null = null;

	return {
		async sleep() {
			const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
			const ms = exponential * (0.5 + Math.random() * 0.5);
			retries += 1;

			const { promise, resolve } = Promise.withResolvers<void>();
			const handle = setTimeout(resolve, ms);
			sleeper = {
				promise,
				wake() {
					clearTimeout(handle);
					resolve();
				},
			};
			await promise;
			sleeper = null;
		},
		wake() {
			sleeper?.wake();
		},
		reset() {
			retries = 0;
		},
	};
}
