import {
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type {
	SyncProvider,
	SyncProviderConfig,
	SyncStatus,
	WebSocketLike,
} from './types';

// ============================================================================
// Helpers
// ============================================================================

/** Convert an HTTP URL to a WebSocket URL (`https:` → `wss:`, `http:` → `ws:`). */
function toWebSocketUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/** A cancellable timeout returned by {@link createSleeper}. */
type Sleeper = {
	/** Resolves when the timeout expires or `wake()` is called. */
	promise: Promise<void>;
	/** Resolves the promise immediately, clearing the pending timeout. */
	wake(): void;
};

/** Compute exponential backoff with jitter: `min(baseDelay * 2^retries, maxDelay) * [0.5, 1.0)`. */
function backoffDelay(retries: number): number {
	const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
	return exponential * (0.5 + Math.random() * 0.5);
}

/** Creates a cancellable timeout that resolves after `timeout` ms, or immediately if `wake()` is called. */
function createSleeper(timeout: number): Sleeper {
	const { promise, resolve } = Promise.withResolvers<void>();
	const handle = setTimeout(resolve, timeout);
	return {
		promise,
		wake() {
			clearTimeout(handle);
			resolve();
		},
	};
}

// ============================================================================
// Constants
// ============================================================================

/** Origin sentinel for sync updates — used to skip echoing remote changes back. */
const SYNC_ORIGIN = Symbol('sync-provider');

/** Base delay before reconnecting after a failed connection attempt. */
const BASE_DELAY_MS = 500;

/** Maximum delay between reconnection attempts. */
const MAX_DELAY_MS = 30_000;

/** Interval between text "ping" messages for liveness detection. */
const PING_INTERVAL_MS = 30_000;

/** Time without any message before the connection is considered dead. */
const LIVENESS_TIMEOUT_MS = 45_000;

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a sync provider that connects a Y.Doc to a WebSocket sync server.
 *
 * Uses V2 encoding for all sync payloads (~40% smaller than V1).
 *
 * Uses a supervisor loop architecture where one loop owns all status transitions
 * and reconnection logic. Event handlers are reporters only — they resolve
 * promises that the loop awaits, but never make reconnection decisions.
 *
 * @example Open mode (localhost, no auth)
 * ```typescript
 * const provider = createSyncProvider({
 *   doc: myDoc,
 *   baseUrl: 'http://localhost:3913/rooms/blog',
 * });
 * ```
 *
 * @example Authenticated mode
 * ```typescript
 * const provider = createSyncProvider({
 *   doc: myDoc,
 *   baseUrl: 'https://sync.epicenter.so/rooms/blog',
 *   getToken: async () => {
 *     const res = await fetch('/api/sync/token');
 *     return (await res.json()).token;
 *   },
 * });
 * ```
 */
export function createSyncProvider({
	doc,
	baseUrl,
	getToken,
	connect: shouldConnect = true,
	WebSocketConstructor: WS = WebSocket,
	awareness = new Awareness(doc),
}: SyncProviderConfig): SyncProvider {
	// ========================================================================
	// Closure State
	// ========================================================================

	/** User intent: should we be connected? Set by connect()/disconnect(). */
	let desired: 'online' | 'offline' = 'offline';

	/** Observable connection status. Set ONLY by the supervisor loop. */
	let status: SyncStatus = 'offline';

	/**
	 * Monotonic counter bumped by disconnect(). The supervisor loop captures
	 * this at entry and exits when its snapshot no longer matches.
	 */
	let runId = 0;

	/** Promise of the currently running supervisor loop, or null if idle. */
	let connectRun: Promise<void> | null = null;

	/** Current retry count for exponential backoff. */
	let retries = 0;

	/** Current WebSocket instance, or null. */
	let websocket: WebSocketLike | null = null;

	/** Current backoff sleeper — can be woken by browser online events. */
	let reconnectSleeper: Sleeper | null = null;

	// ========================================================================
	// Event Listeners
	// ========================================================================

	const statusListeners = new Set<(status: SyncStatus) => void>();

	/**
	 * Transition the provider's observable status and notify all listeners.
	 *
	 * This is the single place status is written — all transitions flow through
	 * here so listeners get a consistent, deduplicated stream. No-ops when the
	 * status hasn't actually changed.
	 */
	function setStatus(newStatus: SyncStatus) {
		if (status === newStatus) return;
		status = newStatus;
		for (const listener of statusListeners) {
			listener(newStatus);
		}
	}

	// ========================================================================
	// WebSocket Send Helper
	// ========================================================================

	/** Send a binary message if the WebSocket is open; silently no-ops otherwise. */
	function send(message: Uint8Array) {
		if (websocket?.readyState === WS.OPEN) {
			websocket.send(message);
		}
	}

	// ========================================================================
	// Y.Doc Update Handler (V2)
	// ========================================================================

	/**
	 * Y.Doc `'updateV2'` handler — broadcasts local mutations to the server.
	 *
	 * Uses {@link SYNC_ORIGIN} as the origin sentinel: when the sync protocol
	 * applies a remote update it passes `SYNC_ORIGIN` as origin, so this handler
	 * skips those to avoid echoing remote changes back to the server.
	 */
	function handleDocUpdate(update: Uint8Array, origin: unknown) {
		if (origin === SYNC_ORIGIN) return;
		send(encodeSyncUpdate({ update }));
	}

	// ========================================================================
	// Awareness Update Handler
	// ========================================================================

	/**
	 * Awareness `'update'` handler — broadcasts local presence changes
	 * (cursor position, user name, selection, etc.) to all connected peers.
	 */
	function handleAwarenessUpdate({
		added,
		updated,
		removed,
	}: {
		added: number[];
		updated: number[];
		removed: number[];
	}) {
		const changedClients = added.concat(updated).concat(removed);
		send(
			encodeAwareness({
				update: encodeAwarenessUpdate(awareness, changedClients),
			}),
		);
	}

	// ========================================================================
	// Browser Online/Offline/Visibility Handlers
	// ========================================================================

	/** Wake the backoff sleeper immediately when the browser comes back online. */
	function handleOnline() {
		reconnectSleeper?.wake();
	}

	/**
	 * Close the socket when the browser reports going offline.
	 * False positives cause a cheap reconnect.
	 */
	function handleOffline() {
		websocket?.close();
	}

	/**
	 * Send an immediate ping when the tab becomes visible.
	 *
	 * Timer callbacks may have been throttled while backgrounded. The ping
	 * triggers a "pong" response; if the connection is dead, the liveness
	 * interval will detect the stale lastMessageTime and close the socket.
	 */
	function handleVisibilityChange() {
		if (document.visibilityState !== 'visible') return;
		if (websocket?.readyState === WS.OPEN) {
			websocket.send('ping');
		}
	}

	// ========================================================================
	// Supervisor Loop (THE core of the provider)
	// ========================================================================

	/**
	 * The supervisor loop is the SINGLE OWNER of:
	 * - Status transitions
	 * - Reconnection decisions
	 * - Socket lifecycle
	 *
	 * Event handlers (onclose, onerror, heartbeat timeout) ONLY resolve
	 * promises. They never call connect() or set status.
	 *
	 * Single `while` loop — no inner retry loop, no token caching.
	 * Calls `getToken()` fresh on each iteration.
	 */
	async function runLoop(myRunId: number) {
		while (desired === 'online' && runId === myRunId) {
			setStatus('connecting');

			// --- Token acquisition (fresh each iteration) ---
			let token: string | undefined;
			if (getToken) {
				try {
					token = await getToken();
				} catch (e) {
					console.warn('[SyncProvider] Failed to get token', e);
					setStatus('connecting');
					const timeout = backoffDelay(retries);
					retries += 1;
					reconnectSleeper = createSleeper(timeout);
					await reconnectSleeper.promise;
					reconnectSleeper = null;
					continue;
				}
			}

			if (runId !== myRunId) break;

			// --- Single connection attempt ---
			const result = await attemptConnection(token, myRunId);

			if (runId !== myRunId) break;

			if (result === 'connected') {
				retries = 0;
			}

			if (result === 'cancelled') break;

			// Connection failed or closed — backoff and retry
			if (desired === 'online' && runId === myRunId) {
				setStatus('connecting');
				const timeout = backoffDelay(retries);
				retries += 1;
				reconnectSleeper = createSleeper(timeout);
				await reconnectSleeper.promise;
				reconnectSleeper = null;
			}
		}

		// Loop exiting — set offline if we were asked to disconnect
		if (desired === 'offline') {
			setStatus('offline');
		}

		connectRun = null;
	}

	/**
	 * Attempt a single WebSocket connection. Returns when the socket closes.
	 *
	 * @returns 'connected' if the handshake completed and we ran until close,
	 *          'failed' if the connection failed before handshake,
	 *          'cancelled' if runId changed during the attempt.
	 */
	async function attemptConnection(
		token: string | undefined,
		myRunId: number,
	): Promise<'connected' | 'failed' | 'cancelled'> {
		setStatus('connecting');

		// Derive WS URL from baseUrl
		let wsUrl = toWebSocketUrl(baseUrl);
		if (token) {
			const parsed = new URL(wsUrl);
			parsed.searchParams.set('token', token);
			wsUrl = parsed.toString();
		}

		const ws = new WS(wsUrl);
		ws.binaryType = 'arraybuffer';
		websocket = ws;

		// --- Promises that event handlers resolve ---
		const { promise: openPromise, resolve: resolveOpen } =
			Promise.withResolvers<boolean>();
		const { promise: closePromise, resolve: resolveClose } =
			Promise.withResolvers<void>();
		let handshakeComplete = false;

		// Liveness state (scoped to this connection attempt)
		let pingInterval: ReturnType<typeof setInterval> | null = null;
		let livenessInterval: ReturnType<typeof setInterval> | null = null;
		let lastMessageTime = Date.now();

		// --- Event handlers (REPORTERS ONLY) ---
		ws.onopen = () => {
			send(encodeSyncStep1({ doc }));

			if (awareness.getLocalState() !== null) {
				send(
					encodeAwarenessStates({
						awareness,
						clients: [doc.clientID],
					}),
				);
			}

			lastMessageTime = Date.now();

			pingInterval = setInterval(() => {
				if (ws.readyState === WS.OPEN) ws.send('ping');
			}, PING_INTERVAL_MS);

			livenessInterval = setInterval(() => {
				if (Date.now() - lastMessageTime > LIVENESS_TIMEOUT_MS) {
					ws.close();
				}
			}, 10_000);

			resolveOpen(true);
		};

		ws.onclose = () => {
			if (pingInterval) clearInterval(pingInterval);
			if (livenessInterval) clearInterval(livenessInterval);

			// Remove remote awareness states (keep our own)
			removeAwarenessStates(
				awareness,
				Array.from(awareness.getStates().keys()).filter(
					(client) => client !== doc.clientID,
				),
				SYNC_ORIGIN,
			);

			websocket = null;
			resolveOpen(false);
			resolveClose();
		};

		ws.onerror = () => {
			// onerror is always followed by onclose — just resolve open
			resolveOpen(false);
		};

		ws.onmessage = (event: MessageEvent) => {
			lastMessageTime = Date.now();

			// Text "pong" from auto-response — liveness confirmed, nothing else to do
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
						doc,
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
						setStatus('connected');
					}
					break;
				}

				case MESSAGE_TYPE.AWARENESS: {
					applyAwarenessUpdate(
						awareness,
						decoding.readVarUint8Array(decoder),
						SYNC_ORIGIN,
					);
					break;
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					send(
						encodeAwarenessStates({
							awareness,
							clients: Array.from(awareness.getStates().keys()),
						}),
					);
					break;
				}
			}
		};

		// --- Wait for open or failure ---
		const opened = await openPromise;
		if (!opened || runId !== myRunId) {
			// Socket failed to open or we were cancelled
			if (ws.readyState !== WS.CLOSED && ws.readyState !== WS.CLOSING) {
				ws.close();
			}
			await closePromise;
			return runId !== myRunId ? 'cancelled' : 'failed';
		}

		// --- Wait for socket to close (we're connected and running) ---
		await closePromise;

		return handshakeComplete ? 'connected' : 'failed';
	}

	// ========================================================================
	// Doc + Awareness Listeners (attach immediately)
	// ========================================================================

	doc.on('updateV2', handleDocUpdate);
	awareness.on('update', handleAwarenessUpdate);

	// ========================================================================
	// Window Event Helpers
	// ========================================================================

	/** Attach browser online/offline/visibility listeners. No-ops in non-browser environments. */
	function addWindowListeners() {
		if (typeof window !== 'undefined') {
			window.addEventListener('offline', handleOffline);
			window.addEventListener('online', handleOnline);
		}
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', handleVisibilityChange);
		}
	}

	/** Detach browser online/offline/visibility listeners. No-ops in non-browser environments. */
	function removeWindowListeners() {
		if (typeof window !== 'undefined') {
			window.removeEventListener('offline', handleOffline);
			window.removeEventListener('online', handleOnline);
		}
		if (typeof document !== 'undefined') {
			document.removeEventListener(
				'visibilitychange',
				handleVisibilityChange,
			);
		}
	}

	// ========================================================================
	// Public API
	// ========================================================================

	if (shouldConnect) {
		// Auto-connect
		desired = 'online';
		addWindowListeners();
		const myRunId = runId;
		connectRun = runLoop(myRunId);
	}

	return {
		get status() {
			return status;
		},

		get awareness() {
			return awareness;
		},

		/**
		 * Start connecting. Idempotent — safe to call multiple times.
		 * If a connect loop is already running, this is a no-op.
		 */
		connect() {
			desired = 'online';
			if (connectRun) return; // Loop already running
			addWindowListeners();
			const myRunId = runId;
			connectRun = runLoop(myRunId);
		},

		/**
		 * Stop connecting and close the socket.
		 * Sets desired state to offline and wakes any sleeping backoff.
		 */
		disconnect() {
			desired = 'offline';
			runId++;
			reconnectSleeper?.wake();
			removeWindowListeners();

			if (websocket) {
				websocket.close();
			}

			// Synchronously set offline so callers see the status immediately
			setStatus('offline');
		},

		/**
		 * Subscribe to status changes. Returns unsubscribe function.
		 */
		onStatusChange(listener: (status: SyncStatus) => void) {
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},

		/**
		 * Clean up everything — disconnect, remove listeners, release resources.
		 */
		destroy() {
			this.disconnect();
			doc.off('updateV2', handleDocUpdate);
			awareness.off('update', handleAwarenessUpdate);
			removeAwarenessStates(awareness, [doc.clientID], 'window unload');
			statusListeners.clear();
		},
	};
}
