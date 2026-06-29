/**
 * Relay-channel wire protocol: the text frames that multiplex named
 * request/response channels over the account-room WebSocket each device already
 * holds (the [collapse spec]'s relay floor). They share that one authenticated
 * socket with Yjs sync (binary frames) and presence, but are independent at the
 * protocol level: the relay forwards a channel's bytes BLIND, exactly as iroh
 * dumb-pipes a bi-stream, and never parses the MCP (or HTTP) payload inside.
 *
 * Frame flow (all text frames on the one socket; `id` is the caller-minted
 * channel correlation id, echoed unchanged; the relay routes by it and forwards
 * everything but the open verbatim):
 *
 *   caller -> relay -> target : `channel_open`   (open a channel to `target`/`route`)
 *   target -> relay -> caller : `channel_accept` (route admitted, target alive)
 *   either <-> relay <-> other: `channel_data`   (an opaque base64 byte chunk)
 *   either <-> relay <-> other: `channel_end`    (clean EOF half-close)
 *   either <-> relay <-> other: `channel_reset`  (refusal / cancel / teardown)
 *
 * Browser-safe: pure TypeBox schemas, no node builtin, so the client transport
 * (`packages/workspace/src/relay-channel/`) and the server router
 * (`packages/server/src/room/channel-router.ts`) share one source of truth, the
 * same way the deleted dispatch protocol was shared. This REPLACES that protocol
 * (`document/dispatch-protocol.ts`): the deleted one routed `action`/`input` and
 * a typed `Result` the relay had to understand; this one is a dumb byte pipe.
 *
 * Minimal on purpose: `channel_data.bytes` is the whole payload (no `seq`, since
 * one ordered WebSocket preserves order end to end), and the open carries no
 * `source` yet (the relay vouches same-user; a relay-authored `source` is the
 * named seam Wave 3 adds when per-device trust needs it).
 */

import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

// ════════════════════════════════════════════════════════════════════════════
// FRAME SCHEMAS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Caller -> relay -> target: open a channel `id` to device `target` on its named
 * `route`. The relay validates `target` is a live same-user device and forwards
 * the frame; the target reads `route` to pick its local route handler.
 */
export const ChannelOpenFrameSchema = Type.Object({
	type: Type.Literal('channel_open'),
	id: Type.String(),
	target: Type.String(),
	route: Type.String(),
});
export type ChannelOpenFrame = Static<typeof ChannelOpenFrameSchema>;

/** Target -> relay -> caller: the route was admitted and the target is alive. */
export const ChannelAcceptFrameSchema = Type.Object({
	type: Type.Literal('channel_accept'),
	id: Type.String(),
});
export type ChannelAcceptFrame = Static<typeof ChannelAcceptFrameSchema>;

/**
 * Either side -> relay -> other: one opaque chunk of the channel's byte stream,
 * base64-encoded so it rides a JSON text frame. The relay forwards `bytes`
 * without decoding; only the two endpoints read it (as MCP today, HTTP later).
 */
export const ChannelDataFrameSchema = Type.Object({
	type: Type.Literal('channel_data'),
	id: Type.String(),
	bytes: Type.String(),
});
export type ChannelDataFrame = Static<typeof ChannelDataFrameSchema>;

/** Either side -> relay -> other: clean end-of-stream (half-close). */
export const ChannelEndFrameSchema = Type.Object({
	type: Type.Literal('channel_end'),
	id: Type.String(),
});
export type ChannelEndFrame = Static<typeof ChannelEndFrameSchema>;

/**
 * Why a channel ended other than cleanly. `offline` (relay: no live target
 * socket) and `refused` (target: route unknown or policy) are the open-time
 * outcomes; `cancelled` (a side aborted), `closed` (normal teardown),
 * `too_large` (a chunk past the socket ceiling), and `protocol_error` (a
 * malformed frame) end an established channel.
 */
export const ChannelResetCodeSchema = Type.Union([
	Type.Literal('offline'),
	Type.Literal('refused'),
	Type.Literal('cancelled'),
	Type.Literal('closed'),
	Type.Literal('too_large'),
	Type.Literal('protocol_error'),
]);
export type ChannelResetCode = Static<typeof ChannelResetCodeSchema>;

/** Either side (or the relay) -> other: the channel is gone, with a reason code. */
export const ChannelResetFrameSchema = Type.Object({
	type: Type.Literal('channel_reset'),
	id: Type.String(),
	code: ChannelResetCodeSchema,
	reason: Type.Optional(Type.String()),
});
export type ChannelResetFrame = Static<typeof ChannelResetFrameSchema>;

/**
 * Every relay-channel frame. The discriminant is `type`, so a receiver narrows
 * with one {@link checkChannelFrame} check and switches.
 */
export const ChannelFrameSchema = Type.Union([
	ChannelOpenFrameSchema,
	ChannelAcceptFrameSchema,
	ChannelDataFrameSchema,
	ChannelEndFrameSchema,
	ChannelResetFrameSchema,
]);
export type ChannelFrame = Static<typeof ChannelFrameSchema>;

// ════════════════════════════════════════════════════════════════════════════
// COMPILED VALIDATOR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Narrow an untrusted text frame to a {@link ChannelFrame}. The server room core
 * uses it to recognize a channel frame and delegate to the channel router
 * instead of closing the socket; the client transport uses it to route an
 * inbound frame to the channel its `id` names. One validator, both ends.
 */
export const checkChannelFrame = Compile(ChannelFrameSchema);
