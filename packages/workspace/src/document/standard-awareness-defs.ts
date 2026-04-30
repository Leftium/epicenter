/**
 * Standard awareness convention for peer presence.
 *
 * Each connected peer publishes a small `peer` descriptor: id, name, and
 * platform. Action discovery is not in awareness. It is fetched on demand via
 * `describeRemoteActions({ presence, rpc }, peerId)`.
 */

import { type } from 'arktype';

/** Closed enum of supported platforms. */
export const Platform = type('"web" | "tauri" | "chrome-extension" | "node"');
export type Platform = typeof Platform.infer;

/** Presence-only descriptor published by each connected peer. */
export const Peer = type({
	id: 'string',
	name: 'string',
	platform: Platform,
});
export type Peer = typeof Peer.infer;

/**
 * Input shape for workspace factories. Identical to `Peer`, kept separate so
 * apps with branded id types can preserve the brand through construction.
 */
export type PeerDescriptor<TId extends string = string> = {
	id: TId;
	name: string;
	platform: Platform;
};

/** Spread into `attachAwareness` defs to enable typed `state.peer` access. */
export const standardAwarenessDefs = {
	peer: Peer,
};

/** A peer's awareness state under the standard `peer` schema. */
export type PeerAwarenessState = { peer: Peer };

/** Result of a `find(peerId)` lookup: clientId plus full peer state. */
export type FoundPeer = { clientId: number; state: PeerAwarenessState };
