/**
 * Standard peer awareness convention used by `openCollaboration`.
 *
 * Each connected peer publishes two fields:
 *
 *     {
 *       identity: { id, name, platform },
 *       actionKeys: ['tabs_close', 'tabs_list', ...],
 *     }
 *
 * `identity` is the stable peer descriptor. `actionKeys` is the alphabetically
 * sorted snake_case key listing of every action the peer hosts, computed once at
 * `openCollaboration` startup. Full action schemas (input shapes, descriptions)
 * are not in awareness; fetch them via `peer.describe()` when needed.
 *
 * `PeerIdentity` is the arktype-validated identity shape that crosses the
 * wire. `peerAwarenessSchema` is the field-keyed schema record consumed by
 * `attachAwareness`. `PeerAwarenessState` is the runtime shape of a peer's
 * published state.
 *
 * NOTE: this file is mid-transition (see spec
 * 20260513T220000-document-sync-and-identity-collapse.md). `PeerIdentity` and
 * the `identity`/`name` fields are scheduled for deletion. The new shape is
 * `Replica` (client-claimed, install-stable) + `Subject` (server-stamped on
 * the wire envelope). Wave 3 swaps the schema record over; Wave 6 deletes
 * the old types.
 */

import { type } from 'arktype';

// ════════════════════════════════════════════════════════════════════════════
// Legacy shape (scheduled for deletion in Wave 6)
// ════════════════════════════════════════════════════════════════════════════

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
	actionKeys: type('string[]'),
};

/** The runtime shape of a peer's awareness state under the standard schema. */
export type PeerAwarenessState = {
	identity: PeerIdentity;
	actionKeys: readonly string[];
};

// ════════════════════════════════════════════════════════════════════════════
// New shape: Replica (client-claimed) + Subject (server-stamped)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Client-claimed peer descriptor. `id` is install-stable (one UUID per device
 * persisted in storage); `platform` is install-property (the runtime the
 * device executes inside). Multiple browser tabs on the same machine publish
 * the same `replica` but distinct Yjs `clientID`s.
 *
 * Replica fields are claimed by the client and only the client knows them.
 * Trust-attested identity (the auth subject) is stamped by the server on the
 * wire envelope, not in this payload.
 */
export const Replica = type({
	id: 'string',
	platform: '"web" | "tauri" | "chrome-extension" | "node"',
});
export type Replica = typeof Replica.infer;

/**
 * Closed enum of supported peer runtimes. Derived from `Replica` so any
 * additions stay schema-driven.
 */
export type Platform = Replica['platform'];

/**
 * Server-stamped subject. The authenticated user id, derived by the server
 * from the OAuth session at WebSocket ingress and attached to the awareness
 * envelope frame. Clients never publish this directly.
 */
export type Subject = string;
