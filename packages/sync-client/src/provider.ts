import {
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStatus,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
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
const DELAY_MS_BEFORE_RECONNECT = 500;

/** Exponential backoff base factor. */
const BACKOFF_BASE = 1.1;

/** Maximum backoff multiplier to prevent excessively long waits. */
const MAX_BACKOFF_COEFFICIENT = 10;

/** Time without receiving any message before sending a heartbeat probe (MESSAGE_SYNC_STATUS). */
const HEARTBEAT_IDLE_MS = 2_000;

/** Time after sending a heartbeat to wait for any response before closing the connection. */
const HEARTBEAT_TIMEOUT_MS = 3_000;

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

	/** Local version counter — incremented on each local Y.Doc update. */
	let localVersion = 0;

	/** Last version the server acknowledged via MESSAGE_SYNC_STATUS echo. */
	let ackedVersion = -1;

	/** Current retry count for exponential backoff. */
	let retries = 0;

	/** Current WebSocket instance, or null. */
	let websocket: WebSocketLike | null = null;

	/** Heartbeat idle timer handle. */
	let heartbeatHandle: ReturnType<typeof setTimeout> | null = null;

	/** Heartbeat timeout timer handle (armed after probe sent). */
	let connectionTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

	/** Current backoff sleeper — can be woken by browser online events. */
	let reconnectSleeper: Sleeper | null = null;

	// ========================================================================
	// Event Listeners
	// ========================================================================

	const statusListeners = new Set<(status: SyncStatus) => void>();
	const localChangesListeners = new Set<(hasLocalChanges: boolean) => void>();

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

	/**
	 * Notify listeners about a transition in the local changes state.
	 *
	 * Only called when `hasLocalChanges` actually toggles — not on every update.
	 * This drives "Saving…" / "Saved" UI without spurious re-renders.
	 */
	function emitLocalChanges(hasChanges: boolean) {
		for (const listener of localChangesListeners) {
			listener(hasChanges);
		}
	}

	// ========================================================================
	// Version Tracking (hasLocalChanges)
	// ========================================================================

	/**
	 * Bump the local version counter after a local Y.Doc mutation.
	 *
	 * Only emits a `localChanges(true)` event on the clean→dirty transition
	 * (i.e., the first unacked change). Subsequent local edits before an ack
	 * just bump the counter silently.
	 */
	function incrementLocalVersion() {
		const wasClean = ackedVersion === localVersion;
		localVersion += 1;
		if (wasClean) {
			emitLocalChanges(true);
		}
	}

	/**
	 * Record the latest version the server has acknowledged via MESSAGE_SYNC_STATUS.
	 *
	 * Uses `Math.max` to guard against out-of-order acks. Only emits
	 * `localChanges(false)` when the acked version catches up to the local
	 * version — the dirty→clean transition.
	 */
	function updateAckedVersion(version: number) {
		version = Math.max(version, ackedVersion);
		const willBecomeClean =
			ackedVersion !== localVersion && version === localVersion;
		ackedVersion = version;
		if (willBecomeClean) {
			emitLocalChanges(false);
		}
	}

	// ========================================================================
	// Heartbeat (MESSAGE_SYNC_STATUS = 102)
	// ========================================================================

	function clearHeartbeat() {
		if (heartbeatHandle) {
			clearTimeout(heartbeatHandle);
			heartbeatHandle = null;
		}
	}

	function clearConnectionTimeout() {
		if (connectionTimeoutHandle) {
			clearTimeout(connectionTimeoutHandle);
			connectionTimeoutHandle = null;
		}
	}

	/**
	 * Reset the heartbeat idle timer. After {@link HEARTBEAT_IDLE_MS} of
	 * silence (no messages sent or received), sends a MESSAGE_SYNC_STATUS
	 * probe to check if the connection is still alive.
	 *
	 * Called on every incoming message and after the WebSocket opens, so
	 * the timer only fires during genuine idle periods.
	 */
	function resetHeartbeat() {
		clearHeartbeat();
		heartbeatHandle = setTimeout(() => {
			sendSyncStatus();
			heartbeatHandle = null;
		}, HEARTBEAT_IDLE_MS);
	}

	/**
	 * Arm a timeout that closes the socket if no response arrives within
	 * {@link HEARTBEAT_TIMEOUT_MS} after a probe is sent.
	 *
	 * Always arms — the Cloudflare backend always echoes MESSAGE_SYNC_STATUS.
	 */
	function armConnectionTimeout() {
		if (connectionTimeoutHandle) return;
		connectionTimeoutHandle = setTimeout(() => {
			websocket?.close();
			connectionTimeoutHandle = null;
		}, HEARTBEAT_TIMEOUT_MS);
	}

	/**
	 * Send a MESSAGE_SYNC_STATUS (102) frame containing the current local version.
	 *
	 * The server echoes this back, which serves two purposes:
	 * 1. **Heartbeat** — proves the connection is alive (arms the timeout).
	 * 2. **Ack tracking** — when the echoed version equals `localVersion`,
	 *    we know all local changes have been persisted server-side.
	 *
	 * Wire format: `[102][varint-length payload][varint localVersion]`
	 */
	function sendSyncStatus() {
		const payload = encoding.encode((encoder) => {
			encoding.writeVarUint(encoder, localVersion);
		});
		send(encodeSyncStatus({ payload }));
		armConnectionTimeout();
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
	 *
	 * After sending the update, bumps the local version and sends a
	 * MESSAGE_SYNC_STATUS probe so the server can ack receipt.
	 */
	function handleDocUpdate(update: Uint8Array, origin: unknown) {
		if (origin === SYNC_ORIGIN) return;

		send(encodeSyncUpdate({ update }));

		incrementLocalVersion();
		sendSyncStatus();
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
	// Browser Online/Offline Handlers
	// ========================================================================

	/** Wake the backoff sleeper immediately when the browser comes back online. */
	function handleOnline() {
		reconnectSleeper?.wake();
	}

	/**
	 * Probe the connection when the browser reports going offline.
	 *
	 * Doesn't blindly trust the browser's offline event (it can be wrong,
	 * e.g. localhost connections). Instead sends a heartbeat probe — if
	 * the connection is truly dead, the timeout will close the socket.
	 */
	function handleOffline() {
		sendSyncStatus();
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
					setStatus('error');
					const timeout =
						DELAY_MS_BEFORE_RECONNECT *
						Math.min(MAX_BACKOFF_COEFFICIENT, BACKOFF_BASE ** retries);
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
				setStatus('error');
				const timeout =
					DELAY_MS_BEFORE_RECONNECT *
					Math.min(MAX_BACKOFF_COEFFICIENT, BACKOFF_BASE ** retries);
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

		// --- Event handlers (REPORTERS ONLY) ---
		ws.onopen = () => {
			setStatus('handshaking');

			send(encodeSyncStep1({ doc }));
			sendSyncStatus();

			if (awareness.getLocalState() !== null) {
				send(
					encodeAwarenessStates({
						awareness,
						clients: [doc.clientID],
					}),
				);
			}

			resetHeartbeat();
			resolveOpen(true);
		};

		ws.onclose = () => {
			clearHeartbeat();
			clearConnectionTimeout();

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
			clearConnectionTimeout();
			resetHeartbeat();

			const data: Uint8Array = new Uint8Array(event.data);
			const decoder = decoding.createDecoder(data);
			const messageType = decoding.readVarUint(decoder);

			switch (messageType) {
				case MESSAGE_TYPE.SYNC: {
					const syncType = decoding.readVarUint(decoder);
					const payload = decoding.readVarUint8Array(decoder);
					const response = handleSyncPayload({
						syncType: syncType as SyncMessageType,
						payload,
						doc,
						origin: SYNC_ORIGIN,
					});
					if (response) {
						send(response);
					} else if (!handshakeComplete) {
						// First null response = server's step2 applied
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

				case MESSAGE_TYPE.SYNC_STATUS: {
					const payload = decoding.readVarUint8Array(decoder);
					const versionDecoder = decoding.createDecoder(payload);
					const version = decoding.readVarUint(versionDecoder);
					updateAckedVersion(version);
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

	/** Attach browser online/offline listeners. No-ops in non-browser environments. */
	function addWindowListeners() {
		if (typeof window !== 'undefined') {
			window.addEventListener('offline', handleOffline);
			window.addEventListener('online', handleOnline);
		}
	}

	/** Detach browser online/offline listeners. No-ops in non-browser environments. */
	function removeWindowListeners() {
		if (typeof window !== 'undefined') {
			window.removeEventListener('offline', handleOffline);
			window.removeEventListener('online', handleOnline);
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

		get hasLocalChanges() {
			return ackedVersion !== localVersion;
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
		 * Subscribe to local changes state changes. Returns unsubscribe function.
		 */
		onLocalChanges(listener: (hasLocalChanges: boolean) => void) {
			localChangesListeners.add(listener);
			return () => {
				localChangesListeners.delete(listener);
			};
		},

		/**
		 * Clean up everything — disconnect, remove listeners, release resources.
		 */
		destroy() {
			desired = 'offline';
			runId++;
			reconnectSleeper?.wake();

			clearHeartbeat();
			clearConnectionTimeout();

			if (websocket) {
				websocket.close();
			}

			// Synchronously set offline so callers see the status immediately
			setStatus('offline');

			doc.off('updateV2', handleDocUpdate);
			awareness.off('update', handleAwarenessUpdate);

			removeAwarenessStates(awareness, [doc.clientID], 'window unload');

			removeWindowListeners();

			statusListeners.clear();
			localChangesListeners.clear();
		},
	};
}
