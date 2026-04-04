/// <reference lib="dom" />

import {
	decodeRpcPayload,
	type DecodedRpcMessage,
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStatus,
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
import type * as Y from 'yjs';

// ============================================================================
// Types
// ============================================================================

/**
 * Error context from the last failed connection attempt.
 *
 * Discriminated on `type`:
 * - `auth` — Token acquisition failed (`getToken` threw)
 * - `connection` — WebSocket failed to open or dropped
 */
export type SyncError =
	| { type: 'auth'; error: unknown }
	| { type: 'connection' };

/**
 * Connection status of the sync transport.
 *
 * Discriminated on `phase`:
 * - `offline` — Not connected, not trying to connect
 * - `connecting` — Attempting to open a WebSocket or performing handshake.
 *   Carries `attempt` (0 = first, 1+ = reconnecting) and optional `lastError`
 *   from the previous failed attempt.
 * - `connected` — Fully synced and communicating
 */
export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; attempt: number; lastError?: SyncError }
	| { phase: 'connected'; hasLocalChanges: boolean };

/**
 * Context provided to extension message handlers registered via
 * {@link TransportConfig.messageHandlers}.
 *
 * Intentionally minimal—extensions access their own state from their
 * construction closure. `send` is provided because the transport owns
 * the WebSocket and handlers may need to reply to incoming messages.
 */
export type MessageHandlerContext = {
	send(message: Uint8Array): void;
};

/**
 * Handler for an inbound message type.
 *
 * The decoder is positioned after the message-type varint—each handler
 * reads whatever sub-framing its message type defines.
 *
 * @example
 * ```typescript
 * const transport = createTransport({
 *   // ...
 *   messageHandlers: {
 *     [MESSAGE_TYPE.RPC]: (decoder, ctx) => {
 *       const rpc = decodeRpcPayload(decoder);
 *       if (rpc.type === 'response') {
 *         // resolve pending request
 *       }
 *     },
 *   },
 * });
 * ```
 */
export type MessageHandler = (
	decoder: decoding.Decoder,
	ctx: MessageHandlerContext,
) => void;

/**
 * Configuration for creating a sync transport.
 *
 * Supports two auth modes:
 * - **Open**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Authenticated**: `url` + `getToken` — dynamic token refresh
 */
export type TransportConfig = {
	/** The Y.Doc to sync. */
	doc: Y.Doc;

	/**
	 * WebSocket URL for the sync room. Called fresh on each connection attempt.
	 */
	url: () => string;

	/**
	 * Dynamic token fetcher for authenticated mode. Called on each connect/reconnect.
	 */
	getToken?: () => Promise<string | null>;

	/** External awareness instance. If provided, dispose() will NOT remove its states. Defaults to `new Awareness(doc)`. */
	awareness?: Awareness;

	/**
	 * Called when an RPC message (101) arrives from the server.
	 *
	 * The transport decodes the RPC payload and delivers the typed
	 * message—the consumer never touches the raw decoder.
	 */
	onRpcMessage?: (rpc: DecodedRpcMessage) => void;

	/**
	 * Extension message handlers for genuinely custom (non-protocol)
	 * message types, keyed by message type number.
	 *
	 * The transport handles all reserved protocol types internally
	 * (SYNC, AWARENESS, QUERY_AWARENESS, SYNC_STATUS, RPC).
	 * Registering a handler for a reserved type throws at construction.
	 *
	 * Each handler receives a lib0 decoder positioned after the message-type
	 * varint, plus a context with `send()` for replying.
	 */
	messageHandlers?: Partial<Record<number, MessageHandler>>;
};

/**
 * A sync transport instance that manages a WebSocket connection to a Yjs
 * sync server.
 *
 * Handles Y.Doc sync, awareness, liveness detection, and reconnection
 * with exponential backoff. Extension message types (like RPC) are handled
 * via registered {@link MessageHandler}s in the transport config.
 */
export type Transport = {
	/** Current connection status. */
	readonly status: SyncStatus;

	/** The awareness instance for user presence. */
	readonly awareness: Awareness;

	/**
	 * Start connecting. Idempotent — safe to call multiple times.
	 * If a connect loop is already running, this is a no-op.
	 */
	connect(): void;

	/**
	 * Stop connecting and close the socket.
	 * Sets desired state to offline and wakes any sleeping backoff.
	 */
	disconnect(): void;

	/**
	 * Force a fresh connection with new credentials.
	 *
	 * Bumps the internal run ID so the supervisor loop restarts its current
	 * iteration with a fresh `getToken()` call and reset backoff—without
	 * exiting the loop. No-op if not currently online.
	 *
	 * Use this when auth state changes (sign-in, sign-out, token refresh).
	 * Unlike `disconnect()` + `connect()`, this is a single atomic operation
	 * with no race condition.
	 */
	reconnect(): void;

	/**
	 * Subscribe to status changes. Returns unsubscribe function.
	 *
	 * @example
	 * ```typescript
	 * const unsub = transport.onStatusChange((status) => {
	 *   switch (status.phase) {
	 *     case 'connected': console.log('Online'); break;
	 *     case 'connecting': console.log(`Attempt ${status.attempt}`); break;
	 *     case 'offline': console.log('Offline'); break;
	 *   }
	 * });
	 * // Later:
	 * unsub();
	 * ```
	 */
	onStatusChange(listener: (status: SyncStatus) => void): () => void;

	/** Send a binary message if the WebSocket is open; silently no-ops otherwise. */
	send(message: Uint8Array): void;

	/**
	 * Clean up everything — disconnect, remove listeners, release resources.
	 * After calling dispose(), the transport is unusable.
	 */
	dispose(): void;
};

// ============================================================================
// Constants
// ============================================================================

/** Origin sentinel for sync updates — used to skip echoing remote changes back. */
const SYNC_ORIGIN = Symbol('sync-transport');

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

/** Core message types handled internally — extensions cannot override these. */
/** Reserved protocol types — extensions cannot override these. */
const CORE_MESSAGE_TYPES = new Set<number>([
	MESSAGE_TYPE.SYNC,
	MESSAGE_TYPE.AWARENESS,
	MESSAGE_TYPE.QUERY_AWARENESS,
	MESSAGE_TYPE.SYNC_STATUS,
	MESSAGE_TYPE.RPC,
]);

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a sync transport that connects a Y.Doc to a WebSocket sync server.
 *
 * Handles Y.Doc sync, awareness, liveness detection, and reconnection with
 * exponential backoff. Extension message types (like RPC) are dispatched to
 * handlers registered via `messageHandlers` in the config.
 *
 * Uses a supervisor loop architecture where one loop owns all status transitions
 * and reconnection logic. Event handlers are reporters only—they resolve
 * promises that the loop awaits, but never make reconnection decisions.
 *
 * Uses V2 encoding for all sync payloads (~40% smaller than V1).
 */
export function createTransport({
	doc,
	getToken,
	awareness: awarenessOption,
	url,
	messageHandlers: extensionHandlers,
	onRpcMessage,
}: TransportConfig): Transport {
	// --- Validate extension handlers don't collide with core protocol ---
	for (const type of Object.keys(extensionHandlers ?? {})) {
		if (CORE_MESSAGE_TYPES.has(Number(type))) {
			throw new Error(`Cannot override core message handler for type ${type}`);
		}
	}

	const ownsAwareness = !awarenessOption;
	const awareness = awarenessOption ?? new Awareness(doc);
	/** User intent: should we be connected? Set by connect()/disconnect(). */
	let desired: 'online' | 'offline' = 'offline';

	const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });

	/**
	 * Monotonic counter bumped by disconnect() and reconnect(). The supervisor
	 * loop captures this at the top of each iteration and `continue`s when
	 * the snapshot no longer matches—restarting with a fresh token.
	 */
	let runId = 0;

	/** Promise of the currently running supervisor loop, or null if idle. */
	let connectRun: Promise<void> | null = null;

	/** Current WebSocket instance, or null. */
	let websocket: WebSocket | null = null;

	const backoff = createBackoff();

	// --- SYNC_STATUS version tracking ---
	let localVersion = 0;
	let ackedVersion = 0;
	let syncStatusTimer: ReturnType<typeof setTimeout> | null = null;

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
		localVersion++;
		// Debounce: send probe after 100ms quiet period, not per-update.
		// "Saving…" appears immediately (localVersion > ackedVersion),
		// the probe just confirms server receipt.
		if (syncStatusTimer) clearTimeout(syncStatusTimer);
		syncStatusTimer = setTimeout(() => {
			send(encodeSyncStatus(localVersion));
			syncStatusTimer = null;
		}, 100);
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

	/** Shared teardown: set offline, bump runId, close socket, remove window listeners. */
	function goOffline() {
		desired = 'offline';
		runId++;
		backoff.wake();
		manageWindowListeners('remove');
		websocket?.close();
		status.set({ phase: 'offline' });
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
	 *
	 * The loop exits only when `desired` is `'offline'` (disconnect).
	 * reconnect() bumps `runId`, causing the current iteration to
	 * `continue` — the loop restarts with a fresh token without exiting.
	 */
	async function runLoop() {
		let attempt = 0;
		let lastError: SyncError | undefined;

		while (desired === 'online') {
			const myRunId = runId;
			status.set({ phase: 'connecting', attempt, lastError });

			// --- Token acquisition (fresh each iteration) ---
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
					console.warn('[SyncTransport] Failed to get token', e);
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

			// --- Single connection attempt ---
			const result = await attemptConnection(token, myRunId);

			if (runId !== myRunId) {
				attempt = 0;
				lastError = undefined;
				continue;
			}

			if (result === 'connected') {
				// Connection was live, then dropped — retry quickly
				backoff.reset();
				lastError = undefined;
			} else {
				// Never connected
				lastError = { type: 'connection' };
			}

			// Backoff before retry
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
		token: string | null,
		myRunId: number,
	): Promise<'connected' | 'failed' | 'cancelled'> {
		let wsUrl = url();
		if (token) {
			const parsed = new URL(wsUrl);
			parsed.searchParams.set('token', token);
			wsUrl = parsed.toString();
		}

		const ws = new WebSocket(wsUrl);
		ws.binaryType = 'arraybuffer';
		websocket = ws;

		// Reset SYNC_STATUS counters for fresh connection
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
						status.set({
							phase: 'connected',
							hasLocalChanges: localVersion > ackedVersion,
						});
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
					const version = decoding.readVarUint(decoder);
					const prevHasChanges = localVersion > ackedVersion;
					ackedVersion = Math.max(ackedVersion, version);
					const nowHasChanges = localVersion > ackedVersion;
					if (prevHasChanges !== nowHasChanges && handshakeComplete) {
						status.set({ phase: 'connected', hasLocalChanges: nowHasChanges });
					}
					break;
				}

				case MESSAGE_TYPE.RPC: {
					const rpc = decodeRpcPayload(decoder);
					onRpcMessage?.(rpc);
					break;
				}

				default: {
					const handler = extensionHandlers?.[messageType];
					if (handler) {
						handler(decoder, { send });
					} else {
						console.warn(
							`[SyncTransport] Unknown message type: ${messageType}`,
						);
					}
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
			connectRun = runLoop();
		},

		disconnect() {
			goOffline();
		},

		reconnect() {
			if (desired !== 'online') return;
			runId++;
			backoff.reset();
			backoff.wake();
			websocket?.close();
		},

		onStatusChange: status.subscribe,

		send,

		dispose() {
			goOffline();
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

	function stop() {
		if (pingInterval) clearInterval(pingInterval);
		if (livenessInterval) clearInterval(livenessInterval);
	}

	return {
		/** Begin sending pings and checking for staleness. */
		start() {
			stop(); // Guard: prevent interval leak on double-start
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
		stop,
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
