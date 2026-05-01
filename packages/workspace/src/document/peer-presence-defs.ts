/**
 * Standard peer awareness convention.
 *
 * Each connected peer publishes a small `peer` identity: id, name, and
 * platform. Action discovery is not in awareness. It is fetched on demand via
 * `createRemoteClient({ peerDirectory, rpc }).describe(peerId)`.
 *
 * `PeerIdentity` is the only arktype-validated shape here because it crosses
 * the wire (awareness state on read, daemon `/peers` response). The plain TS
 * types (`PeerPresenceState`, `ResolvedPeer`) are derived shapes consumed
 * locally and never deserialized from untrusted input.
 */

import { type } from 'arktype';

/** Awareness identity published by each connected peer. */
export const PeerIdentity = type({
	id: 'string',
	name: 'string',
	platform: '"web" | "tauri" | "chrome-extension" | "node"',
});
export type PeerIdentity = typeof PeerIdentity.infer;

/** Closed enum of supported peer runtimes. Derived from the schema above. */
export type PeerRuntime = PeerIdentity['platform'];

/** A peer's awareness state under the standard `peer` schema. */
export type PeerPresenceState = { peer: PeerIdentity };

/** Result of a `find(peerId)` lookup: clientId plus full peer state. */
export type ResolvedPeer = { clientId: number; state: PeerPresenceState };
