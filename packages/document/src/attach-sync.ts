/// <reference lib="dom" />

import {
	encodeAwareness,
	encodeAwarenessStates,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	MESSAGE_TYPE,
	SYNC_MESSAGE_TYPE,
	SYNC_ORIGIN,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import type { Awareness } from 'y-protocols/awareness';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type * as Y from 'yjs';

/**
 * Minimal Y.Doc sync attachment — connects a Y.Doc to a WebSocket sync server.
 *
 * This is a low-level primitive for `packages/document`. It handles the
 * Y.Doc sync protocol (STEP1/STEP2/UPDATE), optional awareness, supervisor
 * loop with exponential backoff, liveness detection, and graceful shutdown.
 *
 * **Not included** (workspace-layer concerns):
 * - RPC between peers (use `@epicenter/workspace` sync extension for that)
 * - Action registration (ditto)
 * - BroadcastChannel cross-tab sync (separate `attachBroadcastChannel` helper)
 * - SYNC_STATUS version acknowledgement (`hasLocalChanges` indicator)
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
	| { phase: 'connected' };

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
};

// ============================================================================
// Constants
// ============================================================================

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
						status.set({ phase: 'connected' });
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

				// SYNC_STATUS, RPC — ignored at this primitive layer.
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
