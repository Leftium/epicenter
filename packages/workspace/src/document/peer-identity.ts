/**
 * Standard peer awareness convention used by `openCollaboration`.
 *
 * Each connected peer publishes two fields:
 *
 *     {
 *       identity: { id, name, platform },
 *       actionPaths: ['tabs.close', 'tabs.list', ...],
 *     }
 *
 * `identity` is the stable peer descriptor. `actionPaths` is the alphabetically
 * sorted dot-path listing of every action the peer hosts, computed once at
 * `openCollaboration` startup. Full action schemas (input shapes, descriptions)
 * are not in awareness; fetch them via `peer.describe()` when needed.
 *
 * `PeerIdentity` is the arktype-validated identity shape that crosses the
 * wire. `peerAwarenessSchema` is the field-keyed schema record consumed by
 * `attachAwareness`. `PeerAwarenessState` is the runtime shape of a peer's
 * published state.
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

/**
 * Field-keyed schema record for the collaboration's standard awareness fields.
 * `attachAwareness` validates each entry independently when reading peer
 * states; malformed states are silently dropped.
 */
export const peerAwarenessSchema = {
	identity: PeerIdentity,
	actionPaths: type('string[]'),
};

/** The runtime shape of a peer's awareness state under the standard schema. */
export type PeerAwarenessState = {
	identity: PeerIdentity;
	actionPaths: readonly string[];
};
