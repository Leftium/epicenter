/**
 * `openCollaboration`: the one collaboration primitive on a document.
 *
 * Connects a Yjs document to the relay, derives per-peer liveness from
 * the server-owned presence channel, and wires inbound dispatch text
 * frames to the local action registry. Caller-side dispatch posts to the
 * selected sync URL's `/dispatch` endpoint and resolves when the
 * recipient's `dispatch_response` arrives.
 *
 * Three independent wire surfaces ride one auth context:
 *
 *   binary WS frames  -> standard y-protocols SYNC (and, during the
 *                        migration, AWARENESS that nothing reads).
 *   text WS frames    -> presence_snapshot / presence_added /
 *                        presence_removed (server-to-client), and
 *                        dispatch_inbound (server -> recipient) /
 *                        dispatch_response (recipient -> server).
 *   HTTP              -> POST .../dispatch (caller-side fire-and-await)
 *
 * The Y.Doc holds durable workspace state; presence lives on the relay's
 * `connections` map; dispatch lives on HTTP. None of the three touch the
 * others.
 *
 * Content docs (rich-text bodies, attachments, nested independently-
 * syncing docs) use the same primitive with `actions: {}`: dispatch
 * handlers stay inert, presence still flows in over the socket for
 * online discovery.
 */

import { MESSAGE_TYPE } from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Logger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import { ACTION_KEY_PATTERN, type ActionRegistry } from '../shared/actions.js';
import {
	type DispatchError,
	type DispatchRequest,
	deriveDispatchUrl,
	dispatch as dispatchOverHttp,
	type LiveDevice,
	runInboundDispatch,
} from './dispatch.js';
import {
	createSyncSupervisor,
	type OpenWebSocket,
	type SyncStatus,
} from './internal/sync-supervisor.js';
import { createPresenceTracker } from './presence.js';

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
	 * Online installs in this workspace, derived from the server-owned
	 * presence channel (`presence_snapshot`, `presence_added`,
	 * `presence_removed` text frames). Deduplicated by `installationId`
	 * (multi-tab same-install collapses to one entry). Self is excluded.
	 */
	readonly devices: {
		list(): LiveDevice[];
		subscribe(fn: (devices: LiveDevice[]) => void): () => void;
	};

	/**
	 * Presence-tracker accessor for callers that need to know whether the
	 * server has delivered its initial snapshot for this session.
	 *
	 * `hasSnapshot` is `false` between WebSocket upgrade and the first
	 * `presence_snapshot` frame, then `true` for the rest of the session.
	 * Consumers like `run-handler.ts` use it to suppress
	 * `PeerNotFound` during the brief pre-snapshot window when
	 * `devices.list()` would otherwise return `[]` for a peer that is in
	 * fact online.
	 */
	readonly presence: {
		readonly hasSnapshot: boolean;
	};

	/**
	 * Fire a dispatch via HTTP POST. The request is sent over the
	 * Worker's HTTP endpoint, not the WebSocket. The relay pushes
	 * `dispatch_inbound` to the recipient's socket and awaits
	 * `dispatch_response` before completing this HTTP request. The
	 * caller's `signal` (or fetch timeout) is the deadline.
	 *
	 * Always returns `Result<unknown, DispatchError>`. For type-narrowed
	 * success payloads, lift through `typedDispatch<TActions>(collab.dispatch)`.
	 */
	dispatch(req: DispatchRequest): Promise<Result<unknown, DispatchError>>;

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

	// Server-owned presence tracker: derives `devices.list()` from text
	// frames pushed by the relay (`presence_snapshot`, `presence_added`,
	// `presence_removed`) instead of from y-protocols Awareness states.
	// Commit 2 deletes the Awareness instance entirely; for now both
	// systems run in parallel so the change can land in two reviewable
	// steps without ever leaving the system broken.
	const presence = createPresenceTracker(installationId);

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
		// Text frames carry two unrelated server-to-client channels:
		// presence (`presence_snapshot` / `presence_added` /
		// `presence_removed`) and dispatch (`dispatch_inbound`). Try the
		// presence tracker first; on a miss, fall through to dispatch.
		onTextFrame(text) {
			if (presence.handleFrame(text)) return;
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

	// `devices` reads directly from the server-owned presence tracker.
	// The tracker dedupes multi-tab same-install (the relay only ever
	// emits one `presence_added` per install) and excludes self via the
	// `selfInstallationId` it was constructed with.
	const devices = {
		list(): LiveDevice[] {
			return presence.list();
		},
		subscribe(fn: (devices: LiveDevice[]) => void): () => void {
			return presence.subscribe(fn);
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
		presence: {
			get hasSnapshot() {
				return presence.hasSnapshot;
			},
		},
		dispatch(req: DispatchRequest) {
			return dispatchOverHttp({
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
		encoding.writeVarUint8Array(
			enc,
			encodeAwarenessUpdate(awareness, clientIDs),
		);
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
