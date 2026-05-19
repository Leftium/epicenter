/**
 * `openCollaboration`: the one collaboration primitive on a document.
 *
 * Connects a Yjs document to the relay, publishes per-peer liveness via
 * y-protocols awareness (`liveness.installationId`), and wires inbound
 * dispatch text frames to the local action registry. Caller-side
 * dispatch fires HTTP `POST /rooms/:room/dispatch` and resolves when
 * the recipient's `dispatch_response` arrives.
 *
 * Three independent wire surfaces ride one auth context:
 *
 *   binary WS frames  -> standard y-protocols SYNC + AWARENESS
 *   text WS frames    -> dispatch_inbound (server -> recipient) and
 *                        dispatch_response (recipient -> server)
 *   HTTP              -> POST .../dispatch (caller-side fire-and-await)
 *
 * The Y.Doc holds durable workspace state; liveness lives in awareness;
 * dispatch lives on HTTP. None of the three touch the others.
 *
 * Content docs (rich-text bodies, attachments, nested independently-
 * syncing docs) use the same primitive with `actions: {}`: dispatch
 * handlers stay inert, awareness still publishes liveness for online
 * discovery.
 */

import type { Logger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
	applyAwarenessUpdate,
	Awareness,
	encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { MESSAGE_TYPE } from '@epicenter/sync';
import { ACTION_KEY_PATTERN, type ActionRegistry } from '../shared/actions.js';
import {
	deriveDispatchUrl,
	type DispatchError,
	type DispatchRequest,
	dispatch as dispatchOverHttp,
	getOnlineInstallationIds,
	type LiveDevice,
	runInboundDispatch,
} from './dispatch.js';
import {
	createSyncSupervisor,
	type OpenWebSocket,
	type SyncStatus,
} from './internal/sync-supervisor.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

export type OpenCollaborationConfig<TActions extends ActionRegistry> = {
	url: string;
	waitFor?: Promise<unknown>;
	openWebSocket?: OpenWebSocket;
	log?: Logger;
	/**
	 * Install-stable identity. Identifies "this install" across reconnects
	 * and tabs. Multiple tabs on the same install publish the same
	 * `installationId`; the relay routes inbound dispatch to the most-
	 * recently-connected socket for that id.
	 */
	installationId: string;
	/**
	 * Local action registry. Pass `{}` for content docs and consume-only
	 * participants. When the registry is empty, inbound `dispatch_inbound`
	 * frames always reply with `ActionNotFound`.
	 */
	actions: TActions;
};

export type Collaboration<TActions extends ActionRegistry = ActionRegistry> = {
	readonly installationId: string;
	readonly actions: TActions;

	readonly status: SyncStatus;
	readonly whenConnected: Promise<void>;
	readonly whenDisposed: Promise<void>;
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	reconnect(): void;

	/**
	 * Online installs in this workspace, derived from awareness liveness
	 * states. Deduplicated by `installationId` (multi-tab same-install
	 * collapses to one entry). Self is excluded.
	 */
	readonly devices: {
		list(): LiveDevice[];
		subscribe(fn: (devices: LiveDevice[]) => void): () => void;
	};

	/**
	 * Fire a dispatch via HTTP POST. The request is sent over the
	 * Worker's HTTP endpoint, not the WebSocket. The relay pushes
	 * `dispatch_inbound` to the recipient's socket and awaits
	 * `dispatch_response` before completing this HTTP request. The
	 * caller's `signal` (or fetch timeout) is the deadline.
	 */
	dispatch<TOutput = unknown>(
		req: DispatchRequest,
	): Promise<Result<TOutput, DispatchError>>;

	/**
	 * Sugar for `ydoc.destroy()`. Both cascade to all attached primitives
	 * via the standard ydoc destroy listener. If the app owns the ydoc
	 * directly, destroying it produces the same teardown.
	 */
	[Symbol.dispose](): void;
};

// ════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

export function openCollaboration<TActions extends ActionRegistry>(
	ydoc: Y.Doc,
	config: OpenCollaborationConfig<TActions>,
): Collaboration<TActions> {
	const userActions = config.actions;

	for (const key of Object.keys(userActions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Action keys must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}

	const installationId = config.installationId;
	const awareness = new Awareness(ydoc);
	awareness.setLocalStateField('liveness', { installationId });

	// Wrap the user-supplied opener so every connect (including reconnects)
	// carries `?installationId=` without callers re-encoding the URL.
	const userOpen = config.openWebSocket;
	const openWebSocket: OpenWebSocket = (rawUrl, protocols) => {
		const url = new URL(rawUrl.toString());
		url.searchParams.set('installationId', installationId);
		return userOpen ? userOpen(url, protocols) : new WebSocket(url, protocols);
	};

	const supervisor = createSyncSupervisor(ydoc, {
		url: config.url,
		waitFor: config.waitFor,
		openWebSocket,
		log: config.log,
		// Inbound AWARENESS frames: apply to our awareness so devices.list()
		// reflects peer state.
		onBinaryFrame(data) {
			const messageType = data[0];
			if (messageType !== MESSAGE_TYPE.AWARENESS) return;
			// Skip the leading message-type byte and the varuint length header
			// of the inner payload; rather than decoding manually we re-read
			// using the canonical lib0 helpers via a small wrapper.
			decodeAndApplyAwarenessFrame({ data, awareness, origin: supervisor });
		},
		// Inbound dispatch_inbound text frames: run the local action,
		// emit dispatch_response back over the same socket.
		onTextFrame(text) {
			void runInboundDispatch({ rawFrame: text, actions: userActions }).then(
				(response) => {
					if (response !== null) supervisor.send(response);
				},
			);
		},
		// On (re)connect, publish our liveness so the relay can record the
		// clientID in the attachment and broadcast to peers.
		onConnected(send) {
			send(encodeAwarenessFrame(awareness, [awareness.clientID]));
		},
	});

	// Outbound: any local awareness change (cursor, typing, liveness)
	// re-encodes our state and forwards to the supervisor. `origin === 'local'`
	// per y-protocols Awareness contract for local-state changes; ignore
	// echoes from applyAwarenessUpdate (origin === supervisor).
	const awarenessUpdateHandler = (
		_changes: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) => {
		if (origin === supervisor) return;
		supervisor.send(encodeAwarenessFrame(awareness, [awareness.clientID]));
	};
	awareness.on('update', awarenessUpdateHandler);

	// devices.list() delegates to `getOnlineInstallationIds` (the awareness
	// reader); devices.subscribe wires a change listener and re-derives the
	// snapshot. Dedup-by-installationId folds multi-tab same-install into
	// one entry.
	const devices = {
		list(): LiveDevice[] {
			return getOnlineInstallationIds({
				awareness,
				selfInstallationId: installationId,
			});
		},
		subscribe(fn: (devices: LiveDevice[]) => void): () => void {
			const handler = () => fn(devices.list());
			awareness.on('change', handler);
			return () => awareness.off('change', handler);
		},
	};

	const dispatchUrl = deriveDispatchUrl(config.url);

	// No explicit awareness teardown: y-protocols `Awareness` registers
	// its own `doc.on('destroy', () => this.destroy())` listener; its
	// `destroy()` calls `super.destroy()` on the lib0 Observable, which
	// clears every subscriber (including our `awarenessUpdateHandler`).

	return {
		installationId,
		actions: userActions,
		get status() {
			return supervisor.status;
		},
		whenConnected: supervisor.whenConnected,
		whenDisposed: supervisor.whenDisposed,
		onStatusChange: supervisor.onStatusChange,
		reconnect: supervisor.reconnect,
		devices,
		dispatch<TOutput = unknown>(req: DispatchRequest) {
			return dispatchOverHttp<TOutput>({
				dispatchUrl,
				installationId,
				req,
			});
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

// ════════════════════════════════════════════════════════════════════════════
// AWARENESS FRAME ENCODING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Encode a y-protocols awareness update as a wire-ready AWARENESS frame:
 *
 *   [varUint MESSAGE_TYPE.AWARENESS][varUint8Array awarenessUpdate]
 *
 * This matches the y-websocket convention used everywhere.
 */
function encodeAwarenessFrame(
	awareness: Awareness,
	clientIDs: number[],
): Uint8Array {
	return encoding.encode((enc) => {
		encoding.writeVarUint(enc, MESSAGE_TYPE.AWARENESS);
		encoding.writeVarUint8Array(enc, encodeAwarenessUpdate(awareness, clientIDs));
	});
}

/**
 * Decode an inbound AWARENESS frame and apply its payload to the local
 * awareness. The frame layout is `[varUint MESSAGE_TYPE][varUint8Array
 * awarenessUpdate]`; we re-read the leading message-type byte to
 * advance the decoder rather than rely on the caller having stripped it.
 */
function decodeAndApplyAwarenessFrame({
	data,
	awareness,
	origin,
}: {
	data: Uint8Array;
	awareness: Awareness;
	origin: unknown;
}): void {
	const decoder = decoding.createDecoder(data);
	decoding.readVarUint(decoder); // message type (already inspected by caller)
	const payload = decoding.readVarUint8Array(decoder);
	applyAwarenessUpdate(awareness, payload, origin);
}
