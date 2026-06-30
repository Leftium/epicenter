/**
 * Presence wire protocol: the relay-owned peer list, plus the one frame the
 * node sends to publish its own presence identity.
 *
 * The relay owns presence (its `connections` map is the source of truth) and
 * broadcasts the FULL peer list on every membership change. The client stores
 * the latest list verbatim: there is no delta protocol and no client-side
 * reassembly, the frame IS the state.
 *
 * The `actions` manifest field is decommissioned: it is retained on the wire
 * (always `{}`) for version-skew safety now that the in-room dispatch subsystem
 * is deleted (ADR-0073), but nothing reads it. The live presence payload is each
 * peer's `nodeId`, `connectedAt`, `agentId`, and `exposedRoutes`.
 *
 * Shared by the relay (`packages/server/src/room/core.ts`, the sender) and
 * the client (`open-collaboration.ts`, the reader).
 *
 * Schemas are TypeBox: they ARE valid JSON Schema at runtime, double as the
 * source of truth for the TypeScript types via `Static`, and feed
 * `typebox/compile`'s `Compile()` to produce checked-once validators reused
 * at every boundary. No hand-written duck-typing helpers.
 */

import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';
import { ActionMetaSchema } from '../shared/actions.js';

/**
 * Wire schema for an action manifest. `Record<string, ActionMeta>` where each
 * value is the metadata-only projection of a callable `Action`. Retained for
 * wire compatibility but no longer populated: producers send `{}` (see the
 * module header). Reuses `ActionMetaSchema` so the type stays valid.
 */
export const ActionManifestSchema = Type.Record(
	Type.String(),
	ActionMetaSchema,
);

/**
 * One peer's entry on the wire.
 *
 * `nodeId` is the peer's relay routing address; `connectedAt` lets receivers
 * render an "online since" affordance. `actions` is decommissioned (always
 * `{}`, retained for wire compatibility; see the module header). `agentId` is
 * the catalog agent
 * this peer answers as (ADR-0025), present only on a peer that mounted with one
 * (a resident daemon) and absent for ordinary participants. It is the join key
 * a picker uses to decorate a durable agent as live: the catalog owns the
 * agent's properties, presence only reports which agent ids are online now.
 */
export const PeerSchema = Type.Object({
	nodeId: Type.String(),
	connectedAt: Type.Number(),
	actions: ActionManifestSchema,
	agentId: Type.Optional(Type.String()),
	/**
	 * The relay-floor route names this peer serves with `relay: 'exposed'` (a
	 * daemon's opted-in MCP gateway routes, e.g. `['books']`). Discovery for the
	 * floor: a consumer reads this to know which devices serve which MCP routes and
	 * auto-mounts them as tool catalogs, rather than blindly probing every device
	 * for a guessed route name. The floor carries tool routes only (ADR-0078), so
	 * every name here is an MCP server. Absent or `[]` for a pure consumer (a
	 * browser exposes nothing). Additive and optional, so an older peer that omits
	 * it is simply not a cross-device tool source.
	 */
	exposedRoutes: Type.Optional(Type.Array(Type.String())),
});
export type Peer = Static<typeof PeerSchema>;

/**
 * Server -> client: full set of currently-connected peers, pushed on every
 * membership or manifest change. `peers` always excludes the receiver's
 * own install: the relay computes the list per-recipient so the client never
 * has to filter self.
 */
export const PresenceFrameSchema = Type.Object({
	type: Type.Literal('presence'),
	peers: Type.Array(PeerSchema),
});
export type PresenceFrame = Static<typeof PresenceFrameSchema>;

/**
 * Client -> server: publish this node's presence identity (its agent
 * designation and exposed route names). The relay stores it against the sending
 * socket's nodeId and rebroadcasts presence so peers see the update. Sent once
 * on connect. `actions` is decommissioned and sent as `{}` (see the module
 * header). `agentId` is set only by a peer that mounted as a resident agent
 * (ADR-0025); ordinary participants omit it.
 */
export const PresencePublishFrameSchema = Type.Object({
	type: Type.Literal('presence_publish'),
	actions: ActionManifestSchema,
	agentId: Type.Optional(Type.String()),
	/** This node's relay-exposed route names; see {@link PeerSchema.exposedRoutes}. */
	exposedRoutes: Type.Optional(Type.Array(Type.String())),
});
export type PresencePublishFrame = Static<typeof PresencePublishFrameSchema>;

/**
 * Pre-compiled validator for inbound presence frames. Used by the client to
 * narrow untrusted text frames at the receive boundary.
 */
export const checkPresenceFrame = Compile(PresenceFrameSchema);

/**
 * Pre-compiled validator for inbound `presence_publish` frames. Used by the
 * relay to validate peer-supplied manifests before storing.
 */
export const checkPresencePublishFrame = Compile(PresencePublishFrameSchema);
