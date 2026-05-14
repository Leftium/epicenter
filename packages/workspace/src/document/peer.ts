/**
 * Peer surface for `openCollaboration`.
 *
 * A `Peer<TActions>` represents one online remote participant, identified
 * by a stable `id` published in awareness. The `peers` surface on a
 * collaboration lists them, finds them, and observes membership changes.
 * Self is never exposed: local actions are reached via
 * `collaboration.actions.*` instead.
 *
 * `peer.invoke` rides ACTION_REQUEST (app action by snake_case key) and
 * `peer.describe` rides RUNTIME_REQUEST (collaboration runtime verb);
 * `openCollaboration` injects `sendActionRequest` and `sendRuntimeRequest` hooks
 * so this module stays decoupled from the supervisor implementation.
 * `peer.test.ts` exercises the surface with mock senders.
 */

import { RpcError, type RuntimeVerb } from '@epicenter/sync';
import { type } from 'arktype';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import type { Awareness } from 'y-protocols/awareness';
import type { ActionManifest, RemoteCallOptions } from '../shared/actions.js';
import type { PeerMetadata } from './internal/sync-supervisor.js';
import {
	type PeerAwarenessState,
	peerAwarenessSchema,
	type Replica,
	type Subject,
} from './peer-identity.js';

// ════════════════════════════════════════════════════════════════════════════
// RPC MAP TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Default RPC action map used when `peer.invoke` has no type narrowing.
 * Accepts any string action with unknown input/output.
 */
export type DefaultRpcMap = Record<string, { input: unknown; output: unknown }>;

/**
 * Constraint for the `TMap` generic on `peer.invoke<TMap>(...)` and
 * `peers.find<TMap>(id)`.
 *
 * Uses `any` (not `unknown`) for input/output because generic constraints
 * need covariant compatibility: `{ input: string }` must extend
 * `{ input: any }` but does NOT extend `{ input: unknown }`.
 *
 * Apps that want typed cross-device dispatch declare a flat map (key -> input/output)
 * and pass it as the type argument to `find` or `invoke`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RpcActionMap = Record<string, { input: any; output: any }>;

// ════════════════════════════════════════════════════════════════════════════
// ERRORS
// ════════════════════════════════════════════════════════════════════════════

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
export type RemoteCallError = RpcError | PeerLeftError;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * One online remote participant.
 *
 * Obtain via `collaboration.peers.find<TActions>(replicaId)` or iteration
 * over `collaboration.peers.list()`. The generic narrows `invoke` key
 * autocomplete and input/output types when the caller knows the remote's
 * action map.
 *
 * Three identifiers live on a peer, each with a distinct lifetime:
 *
 *  - `clientID`: per-session Yjs id. Disambiguates two tabs on one device.
 *  - `replica`: per-install. Same value across reconnects from the same
 *    device, same value for two tabs of the same browser.
 *  - `subject`: per-user. Server-stamped from the auth session. Two
 *    different devices owned by the same user share a subject.
 */
export type Peer<TActions = unknown> = {
	/**
	 * Session-local awareness clientID. Wire artifact, not stable across
	 * reconnects; do not persist.
	 */
	readonly clientID: number;
	/**
	 * Auth-derived user id, stamped by the server on the AWARENESS_ATTESTED
	 * envelope. The trust-boundary field: two clients cannot share a subject
	 * unless they authenticated as the same user.
	 */
	readonly subject: Subject;
	/**
	 * Install-stable descriptor claimed by the client. Two tabs on the same
	 * browser publish the same `replica`. Verifying ownership is the server's
	 * job (via `subject`), not this field.
	 */
	readonly replica: Replica;
	/**
	 * Alphabetically sorted snake_case key listing of every action the peer hosts,
	 * read from awareness. Use for capability-based picks:
	 * `peers.list().find(p => p.actionKeys.includes('recordings_start'))`.
	 */
	readonly actionKeys: readonly string[];

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

/** Remote participants surface exposed by `openCollaboration`. */
export type PeersSurface = {
	/** Online peers, never including self, in clientId-ascending order. */
	list(): Peer[];

	/**
	 * Find by install-stable replica id. Returns the first match in
	 * clientId-ascending order (multi-tab on one device picks the lower
	 * clientID). Returns undefined if no peer with that replica is online.
	 */
	find<TActions = unknown>(replicaId: string): Peer<TActions> | undefined;

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
 * Wire hook injected by `openCollaboration`. The peers surface only needs
 * to dispatch requests and observe awareness changes; everything else lives
 * in the supervisor. Two methods so app action invocation and runtime verbs
 * stay on the same separate planes as their wire kinds.
 */
export type PeerWireHooks = {
	sendActionRequest(
		targetClientId: number,
		action: string,
		input: unknown,
		options: RemoteCallOptions | undefined,
	): Promise<Result<unknown, RpcError>>;
	sendRuntimeRequest(
		targetClientId: number,
		verb: RuntimeVerb,
		options: RemoteCallOptions | undefined,
	): Promise<Result<unknown, RpcError>>;
};

/**
 * Build a `PeersSurface` over `awareness`. Self is filtered both by
 * `Awareness#clientID` (transport-level self) and by `selfReplicaId` (the
 * published replica.id; catches stale-entry-for-self after reconnect, and
 * filters every tab of the same browser).
 *
 * `peerMetadata` is the supervisor-maintained map of envelope-attested
 * `subject` per clientID. Joining it with the awareness payload at read time
 * (rather than copying into the payload) keeps the trust boundary visible:
 * subject only exists for clientIDs the server attested.
 *
 * Awareness states that fail `PeerAwarenessState` validation are silently
 * dropped: a peer running mismatched code appears offline rather than
 * propagating a typed error to every consumer of the surface.
 */
export function createPeersSurface(
	awareness: Awareness,
	peerMetadata: ReadonlyMap<number, PeerMetadata>,
	selfReplicaId: string,
	hooks: PeerWireHooks,
): PeersSurface {
	function readPeers(): Map<number, PeerAwarenessState & { subject: Subject }> {
		const result = new Map<number, PeerAwarenessState & { subject: Subject }>();
		const selfClientId = awareness.clientID;
		for (const [clientId, rawState] of awareness.getStates()) {
			if (clientId === selfClientId) continue;
			if (rawState === null || typeof rawState !== 'object') continue;
			const replicaRaw = (rawState as Record<string, unknown>).replica;
			const actionKeysRaw = (rawState as Record<string, unknown>).actionKeys;
			const replica = peerAwarenessSchema.replica(replicaRaw);
			if (replica instanceof type.errors) continue;
			const actionKeys = peerAwarenessSchema.actionKeys(actionKeysRaw);
			if (actionKeys instanceof type.errors) continue;
			if (replica.id === selfReplicaId) continue;
			// No subject for this clientID means the supervisor saw an
			// awareness state without a matching AWARENESS_ATTESTED envelope.
			// That's only possible if a malicious or misconfigured peer is
			// injecting raw AWARENESS frames the server didn't stamp; drop
			// the peer rather than surface a half-attested entry.
			const metadata = peerMetadata.get(clientId);
			if (!metadata) continue;
			result.set(clientId, { replica, actionKeys, subject: metadata.subject });
		}
		return result;
	}

	function makePeer(
		clientId: number,
		state: PeerAwarenessState & { subject: Subject },
	): Peer {
		return {
			clientID: clientId,
			subject: state.subject,
			replica: state.replica,
			actionKeys: state.actionKeys,
			invoke: (path, input, options) =>
				dispatch(clientId, state.replica.id, path, () =>
					hooks.sendActionRequest(clientId, path, input, options),
				),
			describe: (options) =>
				dispatch(clientId, state.replica.id, 'describe-actions', () =>
					hooks.sendRuntimeRequest(clientId, 'describe-actions', options),
				),
		};
	}

	/**
	 * Wrap a send hook with the PeerLeft watchdog. `label` is used purely for
	 * error reporting (the action key or runtime verb that was in flight when
	 * the peer disappeared).
	 */
	function dispatch<TOutput>(
		targetClientId: number,
		peerId: string,
		label: string,
		send: () => Promise<Result<unknown, RpcError>>,
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
					settle(PeerLeftError.PeerLeft({ peerId, action: label }));
				}
			};
			awareness.on('change', onChange);

			if (!readPeers().has(targetClientId)) {
				settle(PeerLeftError.PeerLeft({ peerId, action: label }));
				return;
			}

			send()
				.then((result) => settle(result as Result<TOutput, RemoteCallError>))
				.catch((cause) =>
					settle(RpcError.ActionFailed({ action: label, cause })),
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
		find<TActions = unknown>(replicaId: string): Peer<TActions> | undefined {
			const peers = readPeers();
			const sortedClientIds = [...peers.keys()].sort((a, b) => a - b);
			for (const clientId of sortedClientIds) {
				const state = peers.get(clientId)!;
				if (state.replica.id === replicaId) {
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
