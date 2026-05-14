/**
 * Standard peer awareness convention used by `openCollaboration`.
 *
 * Each connected peer publishes two fields, both client-claimed:
 *
 *     {
 *       replica: { id, platform },
 *       actionKeys: ['tabs_close', 'tabs_list', ...],
 *     }
 *
 * `replica` is the install-stable peer descriptor. `actionKeys` is the
 * alphabetically sorted snake_case key listing of every action the peer hosts,
 * computed once at `openCollaboration` startup. Full action schemas (input
 * shapes, descriptions) are not in awareness; fetch them via `peer.describe()`
 * when needed.
 *
 * The auth-attested `subject` lives on the WebSocket envelope frame
 * (AWARENESS_ATTESTED), not in this payload. Consumers join the envelope
 * subject (from the supervisor's `peerMetadata`) with the awareness payload
 * (replica, actionKeys) at the peers surface.
 *
 * `Replica` is the arktype-validated identity shape that crosses the wire.
 * `peerAwarenessSchema` is the field-keyed schema record consumed by
 * `attachAwareness`. `PeerAwarenessState` is the runtime shape of a peer's
 * published state.
 *
 * The legacy `PeerIdentity` shape is preserved alongside the new shape only
 * because the daemon's `PeerSnapshot` JSON contract still names it. Both go
 * away in Wave 6 of the document-sync-and-identity-collapse spec.
 */

import { type } from 'arktype';

// ════════════════════════════════════════════════════════════════════════════
// Replica (client-claimed) + Subject (server-stamped envelope)
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

/**
 * Field-keyed schema record for the collaboration's standard awareness fields.
 * `attachAwareness` validates each entry independently when reading peer
 * states; malformed states are silently dropped.
 */
export const peerAwarenessSchema = {
	replica: Replica,
	actionKeys: type('string[]'),
};

/** The runtime shape of a peer's awareness state under the standard schema. */
export type PeerAwarenessState = {
	replica: Replica;
	actionKeys: readonly string[];
};

// ════════════════════════════════════════════════════════════════════════════
// Legacy shape (scheduled for deletion in Wave 6)
//
// The daemon's PeerSnapshot JSON contract still references `PeerIdentity` as
// the peer descriptor type. Keep it exported for the transition; remove with
// the rest of the legacy surface in Wave 6.
// ════════════════════════════════════════════════════════════════════════════

/** Legacy awareness identity. Use `Replica` for new code. */
export const PeerIdentity = type({
	id: 'string',
	name: 'string',
	platform: '"web" | "tauri" | "chrome-extension" | "node"',
});
export type PeerIdentity = typeof PeerIdentity.infer;

/** Closed enum of supported peer runtimes (legacy alias). */
export type PeerRuntime = PeerIdentity['platform'];
