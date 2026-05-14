/// <reference lib="dom" />

/**
 * Internal sync supervisor: connects a Y.Doc to a WebSocket sync server,
 * runs the Yjs sync protocol (STEP1/STEP2/UPDATE), relays awareness frames
 * if an `Awareness` is supplied, and dispatches RPC frames if
 * `onActionRequest` and/or `onRuntimeRequest` is supplied.
 *
 * Two higher-level primitives wrap this module:
 *
 *   - `openCollaboration` supplies `awareness`, `onActionRequest`,
 *     `onRuntimeRequest`, and uses `sendActionRequest`/`sendRuntimeRequest`
 *     to drive its peers surface.
 *   - `attachYjsSync` supplies none of these; it is a pure byte transport for
 *     content docs.
 *
 * Lifecycle is supervisor-driven: connect, exponential backoff with jitter,
 * liveness via 60s pings and 90s timeout, browser online/offline/visibility
 * wakeups, permanent-failure park on 4401 close codes.
 */

import {
	decodeAwarenessAttestedPayload,
	decodeRpcPayload,
	encodeAwareness,
	encodeAwarenessStates,
	encodeRpcActionRequest,
	encodeRpcResponse,
	encodeRpcRuntimeRequest,
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	isRpcError,
	isTransportOrigin,
	MAIN_SUBPROTOCOL,
	MESSAGE_TYPE,
	RpcError,
	type RuntimeVerb,
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
	type Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { RemoteCallOptions } from '../../shared/actions.js';

// ════════════════════════════════════════════════════════════════════════════
// Public types (re-exported via open-collaboration and attach-yjs-sync)
// ════════════════════════════════════════════════════════════════════════════

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
		message: `[sync] server rejected auth: ${code}`,
		code,
	}),
});
export type SyncFailedError = InferErrors<typeof SyncFailedError>;

/** Background lifecycle warnings logged by the supervisor. */
export const SyncSupervisorError = defineErrors({
	WaitForRejected: ({ cause }: { cause: unknown }) => ({
		message: `[sync] waitFor rejected; starting sync anyway: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CloseTimeout: ({ timeoutMs }: { timeoutMs: number }) => ({
		message: `[sync] WebSocket did not fire onclose within ${timeoutMs}ms; resolving whenDisposed anyway`,
		timeoutMs,
	}),
	PermanentClose: ({
		closeCode,
		reason,
	}: {
		closeCode: number;
		reason: SyncFailedReason;
	}) => ({
		message: `[sync] server sent permanent close ${closeCode}: ${reason.code}`,
		closeCode,
		reason,
	}),
});
export type SyncSupervisorError = InferErrors<typeof SyncSupervisorError>;

export type OpenWebSocket = (
	url: string | URL,
	protocols?: string[],
) => Promise<WebSocket> | WebSocket;

/** Incoming app-action RPC request, dispatched by the supervisor when configured. */
type IncomingActionRequest = {
	requestId: number;
	requesterClientId: number;
	action: string;
	input: unknown;
};

/**
 * Incoming collaboration runtime request. Carries a verb instead of an action
 * path: runtime operations live on a separate plane from the app action
 * namespace.
 */
type IncomingRuntimeRequest = {
	requestId: number;
	requesterClientId: number;
	verb: RuntimeVerb;
};

export type SyncSupervisorConfig = {
	url: string;
	waitFor?: Promise<unknown>;
	openWebSocket?: OpenWebSocket;
	log?: Logger;
	/**
	 * Optional Awareness to wire over the same WebSocket. When omitted, no
	 * awareness frames are emitted, accepted, or queried.
	 */
	awareness?: Awareness;
	/**
	 * Optional incoming app-action dispatcher. When omitted, inbound action
	 * requests receive `RpcError.ActionNotFound`. When provided, the supervisor
	 * calls this for every inbound ACTION_REQUEST and sends the resolved
	 * Result back over the wire.
	 */
	onActionRequest?: (rpc: IncomingActionRequest) => Promise<Result<unknown, unknown>>;
	/**
	 * Optional incoming runtime-verb dispatcher. When omitted, inbound runtime
	 * requests receive `RpcError.ActionNotFound`. When provided, the supervisor
	 * routes every RUNTIME_REQUEST to this handler — never to `onActionRequest` —
	 * so app code and collaboration runtime code stay on separate planes.
	 */
	onRuntimeRequest?: (
		request: IncomingRuntimeRequest,
	) => Promise<Result<unknown, unknown>>;
};

/** Server-attested metadata for a remote awareness client. */
export type PeerMetadata = {
	/** Auth-derived subject the server stamped on the AWARENESS_ATTESTED envelope. */
	subject: string;
};

export type SyncSupervisor = {
	whenConnected: Promise<void>;
	readonly status: SyncStatus;
	onStatusChange: (listener: (status: SyncStatus) => void) => () => void;
	reconnect(): void;
	whenDisposed: Promise<void>;
	sendActionRequest(
		target: number,
		action: string,
		input: unknown,
		options?: RemoteCallOptions,
	): Promise<Result<unknown, RpcError>>;
	sendRuntimeRequest(
		target: number,
		verb: RuntimeVerb,
		options?: RemoteCallOptions,
	): Promise<Result<unknown, RpcError>>;
	/**
	 * Read-only snapshot of server-attested metadata per remote Yjs clientID.
	 *
	 * Populated as AWARENESS_ATTESTED envelopes arrive. Entries are removed
	 * when a peer's awareness state is dropped (disconnect or explicit
	 * remove). The peers surface joins this map with the claimed awareness
	 * payload to produce a complete `Peer`.
	 */
	readonly peerMetadata: ReadonlyMap<number, PeerMetadata>;
};

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

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
 * JSON still produces a usable reason (`code: 'unknown'`); we never throw
 * from here.
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

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

export function createSyncSupervisor(
	ydoc: Y.Doc,
	config: SyncSupervisorConfig,
): SyncSupervisor {
	const awareness = config.awareness ?? null;
	const onActionRequest = config.onActionRequest ?? null;
	const onRuntimeRequest = config.onRuntimeRequest ?? null;

	const waitForPromise = config.waitFor;
	const log = config.log ?? createLogger('sync');

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
	// 4401) or on doc destroy before the first handshake.
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

	let websocket: WebSocket | null = null;

	// Outbound RPC state. Cleared on each `ws.onclose`: the next connection is
	// a fresh server-side context, so any in-flight request from the prior
	// connection will never resolve, and the caller deserves an immediate
	// `Disconnected` instead of a timeout.
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
	 * Shared incoming-request bookkeeping for ACTION_REQUEST and
	 * RUNTIME_REQUEST: response envelope, fallback when no handler is
	 * configured. Generic over the rpc shape; only `requestId` and
	 * `requesterClientId` are needed for the response.
	 */
	async function dispatchIncomingRequest<
		R extends { requestId: number; requesterClientId: number },
	>(
		rpc: R,
		handler: ((rpc: R) => Promise<Result<unknown, unknown>>) | null,
		errorLabel: string,
	) {
		const sendResponse = (result: Result<unknown, unknown>) =>
			send(
				encodeRpcResponse({
					requestId: rpc.requestId,
					requesterClientId: rpc.requesterClientId,
					result,
				}),
			);

		if (!handler) {
			sendResponse(RpcError.ActionNotFound({ action: errorLabel }));
			return;
		}

		sendResponse(await handler(rpc));
	}

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

	// Server-attested metadata per remote clientID. The supervisor populates
	// this from AWARENESS_ATTESTED envelopes; entries are pruned when the
	// awareness state for a clientID is removed (peer disconnect).
	const peerMetadata = new Map<number, PeerMetadata>();
	// Subject carried by the currently-being-applied AWARENESS_ATTESTED envelope.
	// `applyAwarenessUpdate` fires the awareness 'update' event synchronously
	// inside its call, so capturing the subject in a closure here lets the
	// metadata listener stamp the right value for every affected clientID
	// without having to parse y-protocols binary inline.
	let currentEnvelopeSubject: string | null = null;

	function handleRemoteAwarenessAttested(subject: string, update: Uint8Array) {
		if (!awareness) return;
		currentEnvelopeSubject = subject;
		try {
			applyAwarenessUpdate(awareness, update, SYNC_ORIGIN);
		} finally {
			currentEnvelopeSubject = null;
		}
	}

	if (awareness) {
		// Track subject by clientID. Only stamp on updates the supervisor
		// originated (origin === SYNC_ORIGIN); local mutations have no
		// envelope and can't attest a subject. Removed clients drop their
		// metadata so callers don't see stale subjects for departed peers.
		awareness.on(
			'update',
			(
				{
					added,
					updated,
					removed,
				}: { added: number[]; updated: number[]; removed: number[] },
				origin: unknown,
			) => {
				if (origin === SYNC_ORIGIN && currentEnvelopeSubject !== null) {
					for (const id of added) {
						peerMetadata.set(id, { subject: currentEnvelopeSubject });
					}
					for (const id of updated) {
						peerMetadata.set(id, { subject: currentEnvelopeSubject });
					}
				}
				for (const id of removed) {
					peerMetadata.delete(id);
				}
			},
		);
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
	// signal aborts. All three are no-ops when the supervisor isn't actively
	// trying to connect, so attaching at construction time before `waitFor`
	// settles is harmless.
	if (typeof window !== 'undefined') {
		window.addEventListener('online', () => backoff.wake(), {
			signal: masterController.signal,
		});
		window.addEventListener('offline', () => websocket?.close(), {
			signal: masterController.signal,
		});
	}
	if (typeof document !== 'undefined') {
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
			const opened = (config.openWebSocket ?? openDefaultWebSocket)(
				config.url,
				[MAIN_SUBPROTOCOL],
			);
			ws = isPromiseLike(opened) ? await opened : opened;
		} catch {
			return 'failed';
		}
		if (signal.aborted) {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
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
					// Legacy/loopback path: bare AWARENESS frames carry no envelope
					// subject. Production servers stamp AWARENESS_ATTESTED instead;
					// the bare case stays here so client-side decoders never crash
					// on a server that hasn't been upgraded yet.
					handleRemoteAwarenessUpdate(decoding.readVarUint8Array(decoder));
					break;
				}

				case MESSAGE_TYPE.AWARENESS_ATTESTED: {
					const { subject, update } = decodeAwarenessAttestedPayload(decoder);
					handleRemoteAwarenessAttested(subject, update);
					break;
				}

				case MESSAGE_TYPE.QUERY_AWARENESS: {
					sendKnownAwarenessStates();
					break;
				}

				case MESSAGE_TYPE.RPC: {
					const rpc = decodeRpcPayload(decoder);
					switch (rpc.type) {
						case 'response': {
							const pending = pendingRequests.get(rpc.requestId);
							if (pending) {
								clearTimeout(pending.timer);
								pendingRequests.delete(rpc.requestId);
								// Trust-the-wire cast: the JSON payload is structurally a
								// Result, but decodeRpcPayload types it as the raw shape.
								pending.resolve(rpc.result as Result<unknown, unknown>);
							}
							break;
						}
						case 'action-request':
							void dispatchIncomingRequest(rpc, onActionRequest, rpc.action);
							break;
						case 'runtime-request':
							void dispatchIncomingRequest(rpc, onRuntimeRequest, rpc.verb);
							break;
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

	// Supervisor loop. Reads `cycleController.signal` fresh each iteration so
	// `reconnect()` swaps the controller and aborts the old; the supervisor
	// wakes from `attemptConnection`, `backoff.sleep`, or the parked-on-failed
	// `waitForAbort` and the next iteration picks up the replacement.
	const supervisorPromise = (async () => {
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
				// Park in `failed` until `reconnect` aborts the cycle to wake us.
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
		if (status.get().phase === 'failed') setStatus({ phase: 'offline' });
		const old = cycleController;
		cycleController = childOf(masterController.signal);
		backoff.reset();
		old.abort();
	}

	ydoc.on('updateV2', handleDocUpdate);
	awareness?.on('update', handleAwarenessUpdate);

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		try {
			masterController.abort();
			connected.reject(
				new Error('[sync] doc destroyed before first handshake'),
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

	/**
	 * Send a request wire frame and track its pending response. Shared between
	 * ACTION_REQUEST (app actions) and RUNTIME_REQUEST (runtime verbs): the
	 * response envelope and timeout/error normalization are identical; only
	 * the encoded wire kind and the action label differ.
	 *
	 * `errorLabel` populates `ActionFailed.action` when the remote returned a
	 * non-RpcError; for app actions it is the action key, for runtime requests
	 * it is the verb.
	 */
	async function sendTrackedRequest(
		encode: (requestId: number) => Uint8Array,
		errorLabel: string,
		{ timeout = DEFAULT_RPC_TIMEOUT_MS }: RemoteCallOptions = {},
	): Promise<Result<unknown, RpcError>> {
		if (masterController.signal.aborted) return RpcError.Disconnected();
		if (websocket?.readyState !== WebSocket.OPEN) {
			return RpcError.Disconnected();
		}

		return new Promise((resolve) => {
			const requestId = nextRequestId++;
			send(encode(requestId));

			const timer = setTimeout(() => {
				pendingRequests.delete(requestId);
				resolve(RpcError.Timeout({ ms: timeout }));
			}, timeout);

			pendingRequests.set(requestId, {
				action: errorLabel,
				resolve: (result) => {
					clearTimeout(timer);
					if (isRpcError(result.error)) {
						resolve(Err(result.error));
					} else if (result.error != null) {
						resolve(
							RpcError.ActionFailed({
								action: errorLabel,
								cause: result.error,
							}),
						);
					} else {
						resolve(Ok(result.data));
					}
				},
				timer,
			});
		});
	}

	return {
		whenConnected: connected.promise,
		get status() {
			return status.get();
		},
		onStatusChange: status.subscribe,
		reconnect,
		whenDisposed,
		sendActionRequest: (target, action, input, options) =>
			sendTrackedRequest(
				(requestId) =>
					encodeRpcActionRequest({
						requestId,
						targetClientId: target,
						requesterClientId: ydoc.clientID,
						action,
						input,
					}),
				action,
				options,
			),
		sendRuntimeRequest: (target, verb, options) =>
			sendTrackedRequest(
				(requestId) =>
					encodeRpcRuntimeRequest({
						requestId,
						targetClientId: target,
						requesterClientId: ydoc.clientID,
						verb,
					}),
				verb,
				options,
			),
		peerMetadata,
	} satisfies SyncSupervisor;
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function openDefaultWebSocket(
	url: string | URL,
	protocols?: string[],
): WebSocket {
	return new WebSocket(url, protocols);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'then' in value &&
		typeof value.then === 'function'
	);
}

/**
 * One-shot promise with idempotent `resolve`/`reject`. Pre-attaches a no-op
 * `.catch` so a rejection without a consumer does not surface as an
 * unhandled rejection.
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
 * Resolves immediately if the socket is null or already CLOSED. A
 * misbehaving server that never sends a close frame should not block
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
 * Aborting the child does NOT abort the parent. The parent->child listener
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
