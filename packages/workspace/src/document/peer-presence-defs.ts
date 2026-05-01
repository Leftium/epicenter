/**
 * Standard peer presence convention.
 *
 * Each connected peer publishes a small `peer` identity: id, name, and
 * platform. Action discovery is not in awareness. It is fetched on demand via
 * `createRemoteClient({ presence, rpc }).describe(peerId)`.
 */

import { type } from 'arktype';

/** Closed enum of supported peer runtimes. */
export const PeerRuntime = type('"web" | "tauri" | "chrome-extension" | "node"');
export type PeerRuntime = typeof PeerRuntime.infer;

/** Presence-only identity published by each connected peer. */
export const PeerIdentity = type({
	id: 'string',
	name: 'string',
	platform: PeerRuntime,
});
export type PeerIdentity = typeof PeerIdentity.infer;

/**
 * Input shape for workspace factories. Identical to `PeerIdentity`, kept
 * separate so apps with branded id types can preserve the brand through
 * construction.
 */
export type PeerIdentityInput<TId extends string = string> = {
	id: TId;
	name: string;
	platform: PeerRuntime;
};

/** Spread into `attachAwareness` defs to enable typed `state.peer` access. */
export const peerPresenceDefs = {
	peer: PeerIdentity,
};

/** A peer's presence state under the standard `peer` schema. */
export type PeerPresenceState = { peer: PeerIdentity };

/** Result of a `find(peerId)` lookup: clientId plus full peer state. */
export type ResolvedPeer = { clientId: number; state: PeerPresenceState };
