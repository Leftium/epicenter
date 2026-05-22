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
 *   binary WS frames  -> standard y-protocols SYNC.
 *   text WS frames    -> presence (server -> client, the full install
 *                        list on every connection change) and
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

import type { Logger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
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
	 * presence channel: the relay pushes the full install list as a
	 * `presence` text frame on every connection change. Deduplicated and
	 * self-excluded by the relay; the client stores the latest list
	 * verbatim.
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

	// Server-owned presence: the relay pushes the full install list as a
	// `presence` text frame on every connection change. The client stores
	// the latest list and notifies subscribers; there is no delta protocol
	// and no client-side reassembly. The relay dedupes multi-tab
	// same-install and excludes the receiver's own install, so the client
	// stores `installs` verbatim.
	let remoteDevices: LiveDevice[] = [];
	const presenceListeners = new Set<(devices: LiveDevice[]) => void>();

	// Returns true if `text` was a recognized `presence` frame (and thus
	// consumed); false if the caller should route it elsewhere (dispatch).
	function handlePresenceFrame(text: string): boolean {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return false;
		}
		if (!parsed || typeof parsed !== 'object') return false;
		if ((parsed as { type?: unknown }).type !== 'presence') return false;
		const installs = (parsed as { installs?: unknown }).installs;
		if (!Array.isArray(installs)) return false;
		remoteDevices = installs
			.filter((id): id is string => typeof id === 'string')
			.map((deviceInstallationId) => ({
				installationId: deviceInstallationId,
			}));
		for (const listener of presenceListeners) listener(remoteDevices);
		return true;
	}

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
		// Text frames carry two unrelated server-to-client channels:
		// presence (the full install list) and dispatch (`dispatch_inbound`).
		// Try presence first; on a miss, fall through to dispatch.
		onTextFrame(text) {
			if (handlePresenceFrame(text)) return;
			void runInboundDispatch({ rawFrame: text, actions: userActions }).then(
				(response) => {
					if (response !== null) supervisor.send(response);
				},
			);
		},
	});

	// `devices` reads the latest relay-pushed presence list directly.
	const devices = {
		list(): LiveDevice[] {
			return remoteDevices;
		},
		subscribe(fn: (devices: LiveDevice[]) => void): () => void {
			presenceListeners.add(fn);
			return () => {
				presenceListeners.delete(fn);
			};
		},
	};

	const dispatchUrl = deriveDispatchUrl(config.url);

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
