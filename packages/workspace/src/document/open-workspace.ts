/**
 * `openWorkspace`: the one workspace primitive.
 *
 * Replaces the four-step `attachSync + attachAwareness + attachRpc +
 * createRemoteClient` chain. One call opens the sync transport, publishes
 * the local identity and action paths in awareness, dispatches inbound RPC
 * against the local action registry, and exposes a typed `peers` surface
 * for cross-peer invocation.
 *
 * Sibling primitive `attachYjsSync` handles content docs (sync-only, no
 * presence, no RPC).
 */

import { RpcError } from '@epicenter/sync';
import type { Logger } from 'wellcrafted/logger';
import { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import {
	type Actions,
	defineQuery,
	describeActions,
	invokeActionForRpc,
	resolveActionPath,
	type SystemActions,
	walkActions,
} from '../shared/actions.js';
import { attachAwareness } from './attach-awareness.js';
import {
	createSyncSupervisor,
	type OpenWebSocket,
	type SyncStatus,
} from './internal/sync-supervisor.js';
import { peerAwarenessSchema, type PeerIdentity } from './peer-identity.js';
import {
	createPeersSurface,
	type PeersSurface,
	SelfInvocationError,
} from './peer.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

export type OpenWorkspaceConfig<TActions extends Actions = Actions> = {
	url: string;
	waitFor?: Promise<unknown>;
	openWebSocket?: OpenWebSocket;
	log?: Logger;
	/** Stable peer identity published in awareness. */
	identity: PeerIdentity;
	/**
	 * Local action registry. May be `{}` for a workspace that only consumes
	 * remote actions. The reserved `system.*` namespace is injected by the
	 * supervisor and must not appear at the top level.
	 */
	actions: TActions;
};

export type Workspace<TActions extends Actions = Actions> = {
	readonly identity: PeerIdentity;
	readonly actions: TActions;

	/**
	 * Underlying y-protocols `Awareness` instance. Compose custom presence
	 * fields (cursors, selections) via
	 * `attachAwareness(ws.awareness, { schema, initial })`. Reserved keys:
	 * `identity` and `actionPaths`.
	 */
	readonly awareness: Awareness;

	readonly status: SyncStatus;
	readonly whenConnected: Promise<void>;
	readonly whenDisposed: Promise<void>;
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	reconnect(): void;
	goOffline(): void;

	readonly peers: PeersSurface;

	/**
	 * Sugar for `ydoc.destroy()`. Both cascade to all attached primitives via
	 * the standard ydoc destroy listener. If the app owns the ydoc directly,
	 * destroying it produces the same teardown.
	 */
	[Symbol.dispose](): void;
};

// ════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

export function openWorkspace<TActions extends Actions>(
	ydoc: Y.Doc,
	config: OpenWorkspaceConfig<TActions>,
): Workspace<TActions> {
	const { identity, actions: userActions } = config;

	if ('system' in userActions) {
		throw new Error(
			"[openWorkspace] user actions cannot define the 'system.*' namespace. It is reserved for runtime meta operations.",
		);
	}

	const systemActions: SystemActions = Object.freeze({
		describe: defineQuery({
			handler: () => describeActions(userActions),
		}),
	});
	const fullActions = Object.freeze({
		...userActions,
		system: systemActions,
	});

	// Computed once at startup. Two peers running the same code publish
	// byte-identical arrays so awareness updates don't ping-pong on ordering
	// differences.
	const actionPaths = Object.freeze(
		Array.from(walkActions(userActions), ([path]) => path).sort(),
	);

	const awareness = new Awareness(ydoc);

	// `attachAwareness` validates the schema on read and merges into the local
	// state so future `attachAwareness(ws.awareness, ...)` calls compose
	// rather than clobber.
	attachAwareness(awareness, {
		schema: peerAwarenessSchema,
		initial: {
			identity,
			actionPaths: [...actionPaths],
		},
	});

	const supervisor = createSyncSupervisor(ydoc, {
		url: config.url,
		waitFor: config.waitFor,
		openWebSocket: config.openWebSocket,
		log: config.log,
		awareness,
		onRpcRequest: async (rpc) => {
			const target = resolveActionPath(fullActions, rpc.action);
			if (!target) return RpcError.ActionNotFound({ action: rpc.action });
			return invokeActionForRpc(target, rpc.input, rpc.action);
		},
	});

	const peers = createPeersSurface(awareness, identity.id, {
		sendRequest: (target, action, input, options) => {
			// Wire fallback for self-RPC. The peers surface filters self by
			// identity.id, so reaching this branch requires a stale clientId
			// reference (deserialized fixture, test injection, future bug).
			if (target === awareness.clientID) {
				return Promise.resolve(SelfInvocationError.SelfInvocation({ action }));
			}
			return supervisor.sendRpcRequest(target, action, input, options);
		},
	});

	return {
		identity,
		actions: userActions,
		awareness,
		get status() {
			return supervisor.status;
		},
		whenConnected: supervisor.whenConnected,
		whenDisposed: supervisor.whenDisposed,
		onStatusChange: supervisor.onStatusChange,
		reconnect: supervisor.reconnect,
		goOffline: supervisor.goOffline,
		peers,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
