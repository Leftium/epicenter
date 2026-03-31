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
	SyncError,
	SyncProvider,
	SyncProviderConfig,
	SyncStatus,
} from './types';

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

/** How often to check whether the liveness timeout has expired. */
const LIVENESS_CHECK_INTERVAL_MS = 10_000;

/** Max time to wait for a WebSocket to open before giving up. */
const CONNECT_TIMEOUT_MS = 15_000;
// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a sync provider that connects a Y.Doc to a WebSocket sync server.
 *
 * Handles cross-device sync via WebSocket. For same-browser cross-tab sync,
 * use `broadcastChannelSync` from `@epicenter/workspace/extensions/sync/broadcast-channel`
 * alongside this provider—they run in parallel safely (Yjs deduplicates).
 *
 * Uses V2 encoding for all sync payloads (~40% smaller than V1).
 *
 * Uses a supervisor loop architecture where one loop owns all status transitions
 * and reconnection logic. Event handlers are reporters only—they resolve
 * promises that the loop awaits, but never make reconnection decisions.
 *
 * Most consumers use `createSyncExtension` from `@epicenter/workspace/extensions/sync`
 * rather than this provider directly. The extension wraps this provider with
 * workspace lifecycle management (waiting for persistence before connecting,
 * auto-cleanup on dispose).
 *
 * @example Recommended: via workspace extension chain
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
 * import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `http://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 *
 * @example Direct usage (open mode, no auth)
 * ```typescript
 * const provider = createSyncProvider({
 *   doc: myDoc,
 *   url: 'ws://localhost:3913/rooms/blog',
 * });
 * provider.connect();
 * ```
 *
 * @example Direct usage (authenticated)
 * ```typescript
 * const provider = createSyncProvider({
 *   doc: myDoc,
 *   url: 'wss://sync.epicenter.so/rooms/blog',
 *   getToken: async () => {
 *     const res = await fetch('/api/sync/token');
 *     return (await res.json()).token;
 *   },
 * });
 * provider.connect();
 * ```
 */
export function createSyncProvider({
	doc,
	getToken,
	awareness: awarenessOption,
	url,
}: SyncProviderConfig): SyncProvider {
	const ownsAwareness = !awarenessOption;
	const awareness = awarenessOption ?? new Awareness(doc);
	/** User intent: should we be connected? Set by connect()/disconnect(). */
	let desired: 'online' | 'offline' = 'offline';

	const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });

	/**
	 * Monotonic counter bumped by disconnect(). The supervisor loop captures
	 * this at entry and exits when its snapshot no longer matches.
	 */
	let runId = 0;

	/** Promise of the currently running supervisor loop, or null if idle. */
	let connectRun: Promise<void> | null = null;

	/** Current WebSocket instance, or null. */
	let websocket: WebSocket | null = null;

	const backoff = createBackoff();

	/** Send a binary message if the WebSocket is open; silently no-ops otherwise. */
	function send(message: Uint8Array) {
		if (websocket?.readyState === WebSocket.OPEN) {
			websocket.send(message);
		}
	}

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

	// --- Browser event handlers ---

	/** Wake the backoff sleeper so we reconnect immediately when the browser comes back online. */
	function handleOnline() {
		backoff.wake();
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
		if (websocket?.readyState === WebSocket.OPEN) {
			websocket.send('ping');
		}
	}

	/** Attach or detach browser online/offline/visibility listeners. */
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

	// --- Supervisor loop ---

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
		let attempt = 0;
		let lastError: SyncError | undefined;

		while (desired === 'online' && runId === myRunId) {
			status.set({ phase: 'connecting', attempt, lastError });

			// --- Token acquisition (fresh each iteration) ---
			let token: string | null = null;
			if (getToken) {
				try {
					token = await getToken();
					if (!token) throw new Error('No token available');
				} catch (e) {
					console.warn('[SyncProvider] Failed to get token', e);
					lastError = { type: 'auth', error: e };
					status.set({ phase: 'connecting', attempt, lastError });
					await backoff.sleep();
					attempt += 1;
					continue;
				}
			}

			// --- Single connection attempt ---
			const result = await attemptConnection(token, myRunId);

			if (result === 'cancelled') break;

			if (result === 'connected') {
				// Connection was live, then dropped — retry quickly
				backoff.reset();
				lastError = undefined;
			} else {
				// Never connected
				lastError = { type: 'connection' };
			}

			// Backoff before retry (skip if cancelled externally)
			if (desired === 'online' && runId === myRunId) {
				attempt += 1;
				status.set({ phase: 'connecting', attempt, lastError });
				await backoff.sleep();
			}
		}

		if (desired === 'offline') {
			status.set({ phase: 'offline' });
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
		let wsUrl = typeof url === 'function' ? url() : url;
		if (token) {
			const parsed = new URL(wsUrl);
			parsed.searchParams.set('token', token);
			wsUrl = parsed.toString();
		}

		const ws = new WebSocket(wsUrl);
		ws.binaryType = 'arraybuffer';
		websocket = ws;

		const { promise: openPromise, resolve: resolveOpen } =
			Promise.withResolvers<boolean>();
		const { promise: closePromise, resolve: resolveClose } =
			Promise.withResolvers<void>();
		let handshakeComplete = false;

		const liveness = createLivenessMonitor(ws);

		// Close the socket if it hasn't opened within CONNECT_TIMEOUT_MS.
		// Protects against black-hole servers where the browser may take
		// minutes to fire onerror.
		const connectTimeout = setTimeout(() => {
			if (ws.readyState === WebSocket.CONNECTING) ws.close();
		}, CONNECT_TIMEOUT_MS);

		ws.onopen = () => {
			clearTimeout(connectTimeout);
			send(encodeSyncStep1({ doc }));

			if (awareness.getLocalState() !== null) {
				send(
					encodeAwarenessStates({
						awareness,
						clients: [doc.clientID],
					}),
				);
			}

			liveness.start();
			resolveOpen(true);
		};

		ws.onclose = () => {
			clearTimeout(connectTimeout);
			liveness.stop();

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
			liveness.touch();

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
						status.set({ phase: 'connected' });
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
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
			await closePromise;
			return runId !== myRunId ? 'cancelled' : 'failed';
		}

		// --- Wait for socket to close (we're connected and running) ---
		await closePromise;

		return handshakeComplete ? 'connected' : 'failed';
	}

	// --- Attach doc + awareness listeners ---

	doc.on('updateV2', handleDocUpdate);
	awareness.on('update', handleAwarenessUpdate);

	return {
		get status() {
			return status.get();
		},

		get awareness() {
			return awareness;
		},

		connect() {
			desired = 'online';
			if (connectRun) return;
			manageWindowListeners('add');
			const myRunId = runId;
			connectRun = runLoop(myRunId);
		},

		disconnect() {
			desired = 'offline';
			runId++;
			backoff.wake();
			manageWindowListeners('remove');

			if (websocket) {
				websocket.close();
			}

			// Synchronously set offline so callers see the status immediately
			status.set({ phase: 'offline' });
		},

		onStatusChange: status.subscribe,

		dispose() {
			this.disconnect();
			doc.off('updateV2', handleDocUpdate);
			awareness.off('update', handleAwarenessUpdate);
			if (ownsAwareness) {
				removeAwarenessStates(awareness, [doc.clientID], 'window unload');
			}
			status.clear();
		},
	};
}

// ============================================================================
// Helpers (hoisted — available throughout the module)
// ============================================================================

/**
 * Creates a status emitter.
 *
 * Encapsulates a value and a listener set into a single unit. Every `set()`
 * call notifies listeners — no dedup, since SyncStatus is an object (objects
 * are never `===` equal) and consumers want every transition including
 * attempt/lastError changes.
 */
function createStatusEmitter<T>(initial: T) {
	let current = initial;
	const listeners = new Set<(value: T) => void>();

	return {
		/** Read the current value. */
		get() {
			return current;
		},

		/** Transition to a new value and notify listeners. */
		set(value: T) {
			current = value;
			for (const listener of listeners) {
				listener(value);
			}
		},

		/** Subscribe to value changes. Returns an unsubscribe function. */
		subscribe(listener: (value: T) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		/** Remove all listeners. */
		clear() {
			listeners.clear();
		},
	};
}

/**
 * Creates a liveness monitor that detects dead WebSocket connections.
 *
 * Encapsulates the ping interval, liveness check interval, and last-message
 * timestamp into a single unit. Call `start()` when the socket opens,
 * `touch()` on every incoming message, and `stop()` on close.
 *
 * If no message arrives within {@link LIVENESS_TIMEOUT_MS}, the socket is closed.
 */
function createLivenessMonitor(ws: WebSocket) {
	let pingInterval: ReturnType<typeof setInterval> | null = null;
	let livenessInterval: ReturnType<typeof setInterval> | null = null;
	let lastMessageTime = 0;

	return {
		/** Begin sending pings and checking for staleness. */
		start() {
			this.stop(); // Guard: prevent interval leak on double-start
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

		/** Record that a message was received. */
		touch() {
			lastMessageTime = Date.now();
		},

		/** Clear all intervals. */
		stop() {
			if (pingInterval) clearInterval(pingInterval);
			if (livenessInterval) clearInterval(livenessInterval);
		},
	};
}

/**
 * Creates a backoff controller with exponential delay, jitter, and a wakeable sleeper.
 *
 * Encapsulates retry count, delay computation, and the cancellable timeout
 * into a single unit. The supervisor loop calls `sleep()` to wait, external
 * events call `wake()` to interrupt, and successful connections call `reset()`.
 */
function createBackoff() {
	let retries = 0;
	let sleeper: { promise: Promise<void>; wake(): void } | null = null;

	return {
		/** Wait for the next backoff delay, then increment retries. */
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

		/** Interrupt a pending sleep immediately. */
		wake() {
			sleeper?.wake();
		},

		/** Reset retry count after a successful connection. */
		reset() {
			retries = 0;
		},
	};
}
