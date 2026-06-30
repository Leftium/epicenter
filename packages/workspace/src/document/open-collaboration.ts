/**
 * `openCollaboration`: the one collaboration primitive on a document.
 *
 * Connects a Yjs document to the relay and derives per-peer liveness and action
 * manifests from the server-owned presence channel. An additive text-frame port
 * (`textPort`) lets the relay-channel layer ride the same socket for cross-device
 * MCP channels without coupling to sync or presence.
 *
 * Two wire surfaces ride one auth context:
 *
 *   binary WS frames  -> standard y-protocols SYNC.
 *   text WS frames    -> server -> client: presence (the full peer list
 *                        including each peer's action manifest, sent on
 *                        every membership or manifest change);
 *                        client -> server: presence_publish (this node's
 *                        manifest, sent once per connect).
 *
 * The Y.Doc holds durable workspace state; presence lives on the relay's
 * `connections` map.
 *
 * Content docs (rich-text bodies, attachments, nested independently-syncing
 * docs) use the same primitive with `actions: {}`: the published manifest is
 * empty, presence still flows in over the socket for online discovery.
 */

import type { Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import {
	ACTION_KEY_PATTERN,
	type ActionManifest,
	type ActionRegistry,
	toActionMeta,
} from '../shared/actions.js';
import {
	createSyncSupervisor,
	type OpenWebSocketFn,
} from './internal/sync-supervisor.js';
import {
	checkPresenceFrame,
	type Peer,
	type PresencePublishFrame,
} from './presence-protocol.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Re-exported from the sync supervisor (its sole declaration) so consumers
 * keep importing `OpenWebSocketFn` from `open-collaboration` while the type has
 * one home. See {@link OpenWebSocketFn} for the contract.
 */
export type { OpenWebSocketFn };

/**
 * Subscribe to a wake signal that should trigger a sync reconnect (e.g. an
 * auth-state transition that may have refreshed the bearer). The callback
 * receives no argument and returns an unsubscribe. Pass `auth.onStateChange`
 * or any compatible function.
 */
export type OnReconnectSignal = (fn: () => void) => () => void;

export type OpenCollaborationConfig<TActions extends ActionRegistry> = {
	/**
	 * WebSocket URL the supervisor connects to, used verbatim. Callers
	 * build it via {@link roomWsUrl} (or any custom builder); the wire
	 * `?nodeId=` query that the relay routes by lives in this URL.
	 * `openCollaboration` does not parse, mutate, or augment it.
	 */
	url: string;
	/**
	 * Opens the relay socket. Pass `auth.openWebSocket` or any function
	 * with the same shape; the supervisor calls this on every connect and
	 * reconnect.
	 */
	openWebSocket: OpenWebSocketFn;
	/**
	 * Subscribe to a wake signal that should trigger a reconnect (token refresh,
	 * sign-in after reauth-required, sign-out then sign-in). Pass
	 * `auth.onStateChange` or any compatible function. The unsubscribe is wired
	 * into `whenDisposed`, so callers do not write reconnect glue.
	 */
	onReconnectSignal: OnReconnectSignal;
	waitFor?: Promise<unknown>;
	/**
	 * Optional deadline for the FIRST sync handshake. When set, the returned
	 * `whenConnected` rejects if STEP2/UPDATE does not land within this many ms.
	 * The supervisor keeps retrying regardless; only this handle's `whenConnected`
	 * view rejects. Omit for long-lived docs (the root doc) that should wait
	 * indefinitely; set it for one-shot reads that must give up if a room stalls.
	 */
	connectDeadlineMs?: number;
	log?: Logger;
	/**
	 * Injected local action registry. Collaboration publishes this registry to
	 * peers as its presence manifest and exposes it as `collaboration.actions`,
	 * but the caller remains the registry owner. Pass `{}` for content docs and
	 * consume-only participants.
	 */
	actions: TActions;
	/**
	 * The catalog agent this peer answers as (ADR-0025), published in presence so
	 * peers can see which agent ids are live. Set only by a resident agent mount
	 * (e.g. a daemon); omit for ordinary participants and content docs.
	 */
	agentId?: string;
	/**
	 * The relay-exposed (MCP) route names this node serves, published in presence so
	 * a peer can auto-mount them as tool catalogs (floor discovery). Set only by a
	 * daemon that opened relay-exposed routes; omit for a pure consumer (a browser
	 * exposes nothing).
	 */
	exposedRoutes?: string[];
};

// ════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reject `whenConnected` if the first handshake has not landed within
 * `deadlineMs`. Decorates the supervisor's one-shot promise without touching its
 * retry loop; the timer clears as soon as the underlying promise settles, so a
 * fast connect leaves no dangling handle. The caller tears the doc down on
 * rejection (e.g. `ydoc.destroy()`).
 */
function withConnectDeadline(
	whenConnected: Promise<void>,
	deadlineMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		whenConnected,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`sync handshake exceeded ${deadlineMs}ms`));
			}, deadlineMs);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export function openCollaboration<TActions extends ActionRegistry>(
	ydoc: Y.Doc,
	config: OpenCollaborationConfig<TActions>,
) {
	const userActions = config.actions;

	for (const key of Object.keys(userActions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Action keys must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}

	// Server-owned presence: the relay pushes the full peer list as a
	// `presence` text frame on every membership or manifest change. Each entry
	// carries the peer's nodeId, connectedAt, and published action
	// manifest. The client stores the latest list and notifies subscribers;
	// there is no delta protocol and no client-side reassembly. The relay
	// dedupes multi-tab same-node (newest-wins by connectedAt) and excludes
	// the receiver's own node, so the client stores `peers` verbatim.
	let remotePeers: Peer[] = [];
	const presenceListeners = new Set<(peers: Peer[]) => void>();

	// Observers of every inbound text frame, additive to presence. The
	// relay-channel layer (a separate module) subscribes here and narrows to its
	// own frames, so it rides this socket without coupling to sync or presence.
	const textFrameListeners = new Set<(text: string) => void>();

	// Store the latest peer list from a recognized `presence` frame; ignore
	// any other text frame (the relay-channel layer reads those via textPort).
	function handlePresenceFrame(text: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (!checkPresenceFrame.Check(parsed)) return;
		remotePeers = parsed.peers;
		for (const listener of presenceListeners) listener(remotePeers);
	}

	// Build the manifest once at construction time. The action registry is
	// fixed for the lifetime of this Collaboration, so we cache the JSON form
	// and publish it on every (re)connect.
	const ownManifest: ActionManifest = {};
	for (const [key, action] of Object.entries(userActions)) {
		ownManifest[key] = toActionMeta(action);
	}
	const presencePublishFrame = JSON.stringify({
		type: 'presence_publish',
		actions: ownManifest,
		agentId: config.agentId,
		...(config.exposedRoutes !== undefined && {
			exposedRoutes: config.exposedRoutes,
		}),
	} satisfies PresencePublishFrame);

	const supervisor = createSyncSupervisor(ydoc, {
		url: config.url,
		waitFor: config.waitFor,
		openWebSocket: config.openWebSocket,
		log: config.log,
		// Text frames carry the server-owned presence channel. Additive
		// observers (the relay-channel layer) see every text frame through
		// `textFrameListeners` and narrow to their own frames.
		onTextFrame(text) {
			for (const listener of textFrameListeners) listener(text);
			handlePresenceFrame(text);
		},
	});

	const unsubscribeStatusListener = supervisor.onStatusChange((status) => {
		// Publish this node's action manifest on every (re)connect. The relay
		// stores it against the new socket and rebroadcasts presence so peers
		// see it.
		if (status.phase === 'connected') {
			supervisor.send(presencePublishFrame);
		}
	});

	// Reconnect wake: tell the live socket to retry whenever the caller signals
	// that credentials may have changed. Today the only producer is
	// `auth.onStateChange` (token refresh, reauth-required to signed-in,
	// sign-in after sign-out); the supervisor's own state machine decides
	// whether the reconnect actually does anything.
	const unsubscribeReconnectSignal = config.onReconnectSignal(() => {
		supervisor.reconnect();
	});

	void supervisor.whenDisposed.then(() => {
		unsubscribeStatusListener();
		unsubscribeReconnectSignal();
	});

	// `peers` reads the latest relay-pushed presence list directly.
	const peers = {
		list(): Peer[] {
			return remotePeers;
		},
		subscribe(fn: (peers: Peer[]) => void): () => void {
			presenceListeners.add(fn);
			return () => {
				presenceListeners.delete(fn);
			};
		},
	};

	// A connect deadline is a one-shot, caller-scoped view: only this handle's
	// `whenConnected` rejects after the deadline; the supervisor keeps retrying.
	const whenConnected =
		config.connectDeadlineMs === undefined
			? supervisor.whenConnected
			: withConnectDeadline(supervisor.whenConnected, config.connectDeadlineMs);

	return {
		/** Local action registry published through this collaboration handle. */
		get actions() {
			return userActions;
		},
		/** Current sync lifecycle status. */
		get status() {
			return supervisor.status;
		},
		/** Resolves after the first successful sync handshake. */
		whenConnected,
		/** Resolves after document destroy tears down collaboration. */
		whenDisposed: supervisor.whenDisposed,
		/** Subscribe to sync status changes. Returns an unsubscribe function. */
		onStatusChange: supervisor.onStatusChange,
		/** Restart the current connection cycle. */
		reconnect: supervisor.reconnect,
		/**
		 * The raw text-frame port over this socket: send a text frame, and observe
		 * every inbound one. The relay-channel layer builds a `ChannelPort` on top
		 * (see `relay-channel/createChannelPort`); this handle stays sync-agnostic
		 * and never parses a channel frame.
		 */
		textPort: {
			send: (text: string) => supervisor.send(text),
			subscribe: (listener: (text: string) => void): (() => void) => {
				textFrameListeners.add(listener);
				return () => textFrameListeners.delete(listener);
			},
		},
		/**
		 * Online peers in this workspace, derived from the server-owned
		 * presence channel.
		 */
		get peers() {
			return peers;
		},
		/** Destroy the Y.Doc, cascading teardown to attached primitives. */
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type Collaboration<TActions extends ActionRegistry = ActionRegistry> =
	ReturnType<typeof openCollaboration<TActions>>;
