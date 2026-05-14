/**
 * `openCollaboration`: the one collaboration primitive on a document.
 *
 * Replaces the four-step `attachSync + attachAwareness + attachRpc +
 * createRemoteClient` chain. One call opens the sync transport, publishes
 * the local identity and action keys in awareness, dispatches inbound RPC
 * against the local action registry, and exposes a typed `peers` surface
 * for cross-peer invocation.
 *
 * Naming model: a document stores local-first app data; collaboration
 * publishes its actions and makes it live with peers. Local invocation is
 * `collaboration.actions.action_key(input)`; remote invocation is
 * `collaboration.peers.find<TActions>(peerId)?.invoke('action_key', input)`.
 *
 * Sibling primitive `attachYjsSync` handles content docs (sync-only, no
 * presence, no RPC).
 */

import { RpcError } from '@epicenter/sync';
import type { Logger } from 'wellcrafted/logger';
import { Awareness } from 'y-protocols/awareness';
import { Ok } from 'wellcrafted/result';
import type * as Y from 'yjs';
import {
	ACTION_KEY_PATTERN,
	type ActionRegistry,
	invokeActionForRpc,
	toActionMeta,
} from '../shared/actions.js';
import { attachAwareness } from './attach-awareness.js';
import {
	createSyncSupervisor,
	type OpenWebSocket,
	type SyncStatus,
} from './internal/sync-supervisor.js';
import { peerAwarenessSchema, type Replica } from './peer-identity.js';
import {
	createPeersSurface,
	type PeersSurface,
	SelfInvocationError,
} from './peer.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

export type OpenCollaborationConfig<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	url: string;
	waitFor?: Promise<unknown>;
	openWebSocket?: OpenWebSocket;
	log?: Logger;
	/**
	 * Install-stable, client-claimed descriptor published in awareness. The
	 * authenticated `subject` is stamped by the server on the wire envelope;
	 * clients only publish what only they know.
	 */
	replica: Replica;
	/**
	 * Local action registry published to peers. Defaults to `{}` for content
	 * docs and consume-only participants. The registry is yours alone:
	 * collaboration runtime requests (e.g. peer.describe) ride a separate wire
	 * kind (`RUNTIME_REQUEST`), not the action namespace.
	 */
	actions?: TActions;
};

export type Collaboration<
	TActions extends ActionRegistry = ActionRegistry,
> = {
	readonly replica: Replica;
	readonly actions: TActions;

	readonly status: SyncStatus;
	readonly whenConnected: Promise<void>;
	readonly whenDisposed: Promise<void>;
	onStatusChange(listener: (status: SyncStatus) => void): () => void;
	reconnect(): void;

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

export function openCollaboration<TActions extends ActionRegistry>(
	ydoc: Y.Doc,
	config: OpenCollaborationConfig<TActions>,
): Collaboration<TActions> {
	const { replica } = config;
	const userActions = (config.actions ?? ({} as TActions)) as TActions;

	for (const key of Object.keys(userActions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Action keys must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}

	// Computed once at startup. Two peers running the same code publish
	// byte-identical arrays so awareness updates don't ping-pong on ordering
	// differences.
	const actionKeys = Object.freeze(Object.keys(userActions).sort());

	const awareness = new Awareness(ydoc);

	attachAwareness(awareness, {
		schema: peerAwarenessSchema,
		initial: {
			replica,
			actionKeys: [...actionKeys],
		},
	});

	const supervisor = createSyncSupervisor(ydoc, {
		url: config.url,
		waitFor: config.waitFor,
		openWebSocket: config.openWebSocket,
		log: config.log,
		awareness,
		onActionRequest: async (rpc) => {
			const target = userActions[rpc.action];
			if (!target) return RpcError.ActionNotFound({ action: rpc.action });
			return invokeActionForRpc(target, rpc.input, rpc.action);
		},
		onRuntimeRequest: async (rpc) => {
			// Closed-set switch. Adding a new verb without a branch here is a
			// compile error, so the runtime can never silently drop a verb peers
			// expect us to handle.
			switch (rpc.verb) {
				case 'describe-actions':
					return Ok(
						Object.fromEntries(
							Object.entries(userActions).map(([key, action]) => [
								key,
								toActionMeta(action),
							]),
						),
					);
			}
		},
	});

	const peers = createPeersSurface(awareness, supervisor.peerMetadata, replica.id, {
		sendActionRequest: (target, action, input, options) => {
			// Wire fallback for self-RPC. The peers surface filters self by
			// replica.id, so reaching this branch requires a stale clientId
			// reference (deserialized fixture, test injection, future bug).
			if (target === awareness.clientID) {
				return Promise.resolve(SelfInvocationError.SelfInvocation({ action }));
			}
			return supervisor.sendActionRequest(target, action, input, options);
		},
		sendRuntimeRequest: (target, verb, options) => {
			if (target === awareness.clientID) {
				return Promise.resolve(SelfInvocationError.SelfInvocation({ action: verb }));
			}
			return supervisor.sendRuntimeRequest(target, verb, options);
		},
	});

	return {
		replica,
		actions: userActions,
		get status() {
			return supervisor.status;
		},
		whenConnected: supervisor.whenConnected,
		whenDisposed: supervisor.whenDisposed,
		onStatusChange: supervisor.onStatusChange,
		reconnect: supervisor.reconnect,
		peers,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
