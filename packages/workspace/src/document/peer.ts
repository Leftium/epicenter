/**
 * Peer surface for `openWorkspace`.
 *
 * A `Peer<TActions>` represents one online remote workspace, identified by
 * a stable `id` published in awareness. The `peers` surface on a workspace
 * lists them, finds them, and observes membership changes. Self is never
 * exposed: local actions are reached via `ws.actions.*` instead.
 *
 * Wire-level dispatch (`peer.invoke`, `peer.describe`) is wired by
 * `openWorkspace`, which injects a `sendRequest` hook so this module stays
 * decoupled from the supervisor implementation. `peer.test.ts` exercises
 * the surface with a mock sender.
 */

import { RpcError } from '@epicenter/sync';
import { type } from 'arktype';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Awareness } from 'y-protocols/awareness';
import type { DefaultRpcMap, RpcActionMap } from '../rpc/types.js';
import type {
	ActionManifest,
	RemoteCallOptions,
} from '../shared/actions.js';
import {
	peerAwarenessSchema,
	type PeerAwarenessState,
	type PeerIdentity,
} from './peer-identity.js';

// ════════════════════════════════════════════════════════════════════════════
// ERRORS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Self-RPC attempted at the wire layer. The peers surface filters self by
 * identity, so reaching this variant requires a stale clientId reference
 * (deserialized fixture, test injection, future bug). The type system
 * makes this unreachable for typical callers; the wire fallback keeps the
 * failure typed if it slips through.
 */
export const SelfInvocationError = defineErrors({
	SelfInvocation: ({ action }: { action: string }) => ({
		message: `[openWorkspace] cannot RPC to self for "${action}"; call ws.actions.${action} directly`,
		action,
	}),
});
export type SelfInvocationError = InferErrors<typeof SelfInvocationError>;

/** Target peer disappeared from awareness while an RPC was in flight. */
export const PeerLeftError = defineErrors({
	PeerLeft: ({ peerId, action }: { peerId: string; action: string }) => ({
		message: `peer "${peerId}" disconnected before "${action}" response arrived`,
		peerId,
		action,
	}),
});
export type PeerLeftError = InferErrors<typeof PeerLeftError>;

/** Errors that may surface from `peer.invoke` or `peer.describe`. */
export type RemoteCallError = RpcError | SelfInvocationError | PeerLeftError;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * One online remote workspace.
 *
 * Obtain via `ws.peers.find<TActions>(peerId)` or iteration over
 * `ws.peers.list()`. The generic narrows `invoke` path autocomplete and
 * input/output types when the caller knows the remote's action map.
 */
export type Peer<TActions = unknown> = {
	readonly id: string;
	readonly identity: PeerIdentity;
	/**
	 * Session-local awareness clientID. Wire artifact, not stable across
	 * reconnects; do not persist. Useful when `id` is shared (multiple tabs
	 * from one browser) and a caller needs to disambiguate entries.
	 */
	readonly clientID: number;
	/**
	 * Alphabetically sorted dot-path listing of every action the peer hosts,
	 * read from awareness. Use for capability-based picks:
	 * `peers.list().find(p => p.actionPaths.includes('whispering.startRecording'))`.
	 */
	readonly actionPaths: readonly string[];

	invoke<
		TMap extends RpcActionMap = TActions extends RpcActionMap
			? TActions
			: DefaultRpcMap,
		TPath extends string & keyof TMap = string & keyof TMap,
	>(
		path: TPath,
		input: TMap[TPath]['input'],
		options?: RemoteCallOptions,
	): Promise<Result<TMap[TPath]['output'], RemoteCallError>>;

	describe(
		options?: RemoteCallOptions,
	): Promise<Result<ActionManifest, RemoteCallError>>;
};

/** Remote workspace surface exposed by `openWorkspace`. */
export type PeersSurface = {
	/** Online peers, never including self, in clientId-ascending order. */
	list(): Peer[];

	/** Find by stable peer id. Returns undefined if not currently online. */
	find<TActions = unknown>(peerId: string): Peer<TActions> | undefined;

	/**
	 * Subscribe to changes in the peer list. Bare callback; snapshot reads
	 * via `list()` are cheap so a delta API isn't worth doubling the surface.
	 * Returns unsubscribe.
	 */
	observe(callback: () => void): () => void;
};

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL: peers-surface factory
// ════════════════════════════════════════════════════════════════════════════

/**
 * Wire hook injected by `openWorkspace`. The peers surface only needs to
 * dispatch a request and observe awareness change; everything else lives in
 * the supervisor.
 */
export type PeerWireHooks = {
	sendRequest(
		targetClientId: number,
		action: string,
		input: unknown,
		options: RemoteCallOptions | undefined,
	): Promise<Result<unknown, RpcError | SelfInvocationError>>;
};

/**
 * Build a `PeersSurface` over `awareness`. Self is filtered both by
 * `Awareness#clientID` (transport-level self) and by `selfId` (the published
 * identity.id; catches stale-entry-for-self after reconnect).
 *
 * Awareness states that fail `PeerAwarenessState` validation are silently
 * dropped: a peer running mismatched code appears offline rather than
 * propagating a typed error to every consumer of the surface.
 */
export function createPeersSurface(
	awareness: Awareness,
	selfId: string,
	hooks: PeerWireHooks,
): PeersSurface {
	function readPeers(): Map<number, PeerAwarenessState> {
		const result = new Map<number, PeerAwarenessState>();
		const selfClientId = awareness.clientID;
		for (const [clientId, rawState] of awareness.getStates()) {
			if (clientId === selfClientId) continue;
			if (rawState === null || typeof rawState !== 'object') continue;
			const identityRaw = (rawState as Record<string, unknown>).identity;
			const actionPathsRaw = (rawState as Record<string, unknown>).actionPaths;
			const identity = peerAwarenessSchema.identity(identityRaw);
			if (identity instanceof type.errors) continue;
			const actionPaths = peerAwarenessSchema.actionPaths(actionPathsRaw);
			if (actionPaths instanceof type.errors) continue;
			if (identity.id === selfId) continue;
			result.set(clientId, { identity, actionPaths });
		}
		return result;
	}

	function makePeer(clientId: number, state: PeerAwarenessState): Peer {
		return {
			id: state.identity.id,
			identity: state.identity,
			clientID: clientId,
			actionPaths: state.actionPaths,
			invoke: (path, input, options) =>
				dispatch(clientId, state.identity.id, path, input, options),
			describe: (options) =>
				dispatch(clientId, state.identity.id, 'system.describe', undefined, options),
		};
	}

	function dispatch<TOutput>(
		targetClientId: number,
		peerId: string,
		path: string,
		input: unknown,
		options: RemoteCallOptions | undefined,
	): Promise<Result<TOutput, RemoteCallError>> {
		return new Promise<Result<TOutput, RemoteCallError>>((resolve) => {
			let settled = false;
			const settle = (value: Result<TOutput, RemoteCallError>) => {
				if (settled) return;
				settled = true;
				awareness.off('change', onChange);
				resolve(value);
			};

			const onChange = () => {
				if (!readPeers().has(targetClientId)) {
					settle(PeerLeftError.PeerLeft({ peerId, action: path }));
				}
			};
			awareness.on('change', onChange);

			if (!readPeers().has(targetClientId)) {
				settle(PeerLeftError.PeerLeft({ peerId, action: path }));
				return;
			}

			hooks
				.sendRequest(targetClientId, path, input, options)
				.then((result) => settle(result as Result<TOutput, RemoteCallError>))
				.catch((cause) =>
					settle(RpcError.ActionFailed({ action: path, cause })),
				);
		});
	}

	return {
		list() {
			const peers = readPeers();
			const clientIds = [...peers.keys()].sort((a, b) => a - b);
			return clientIds.map((clientId) =>
				makePeer(clientId, peers.get(clientId)!),
			);
		},
		find<TActions = unknown>(peerId: string): Peer<TActions> | undefined {
			const peers = readPeers();
			const sortedClientIds = [...peers.keys()].sort((a, b) => a - b);
			for (const clientId of sortedClientIds) {
				const state = peers.get(clientId)!;
				if (state.identity.id === peerId) {
					return makePeer(clientId, state) as Peer<TActions>;
				}
			}
			return undefined;
		},
		observe(callback) {
			const handler = () => callback();
			awareness.on('change', handler);
			return () => awareness.off('change', handler);
		},
	};
}

// ════════════════════════════════════════════════════════════════════════════
// waitForPeer
// ════════════════════════════════════════════════════════════════════════════

/**
 * Wait for a peer with the given id to become online. Resolves with the
 * `Peer` on first sighting, or `undefined` if `timeoutMs` elapses without
 * the peer appearing. `timeoutMs <= 0` is a synchronous one-shot lookup
 * wrapped in a promise.
 */
export async function waitForPeer<TActions = unknown>(
	peers: PeersSurface,
	peerId: string,
	{ timeoutMs }: { timeoutMs: number },
): Promise<Peer<TActions> | undefined> {
	const initial = peers.find<TActions>(peerId);
	if (initial) return initial;
	if (timeoutMs <= 0) return undefined;

	return new Promise<Peer<TActions> | undefined>((resolve) => {
		const unsubscribe = peers.observe(() => {
			const found = peers.find<TActions>(peerId);
			if (!found) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(found);
		});
		const timer = setTimeout(() => {
			unsubscribe();
			resolve(undefined);
		}, timeoutMs);
	});
}
