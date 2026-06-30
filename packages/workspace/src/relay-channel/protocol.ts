/**
 * Relay-channel wire protocol: the text frames that multiplex named
 * request/response channels over the account-room WebSocket each device already
 * holds (the [collapse spec]'s relay floor). They share that one authenticated
 * socket with Yjs sync (binary frames) and presence, but are independent at the
 * protocol level: the relay forwards a channel's bytes BLIND and never parses
 * the MCP (or HTTP) payload inside.
 *
 * Frame flow (all text frames on the one socket; `id` is the caller-minted
 * channel correlation id, echoed unchanged; the relay routes by it and forwards
 * everything but the open verbatim):
 *
 *   caller -> relay -> target : `channel_open`   (open a channel to `target`/`route`)
 *   target -> relay -> caller : `channel_accept` (route admitted, target alive)
 *   either <-> relay <-> other: `channel_data`   (an opaque base64 byte chunk)
 *   either <-> relay <-> other: `channel_reset`  (the terminal frame, both directions)
 *
 * Terminal flow is RESET-ONLY: there is no half-close `channel_end`. The one
 * consumer (an MCP session) only closes the whole session, so a single
 * `channel_reset` carries the terminal signal both ways, `closed` meaning a clean
 * end and any other code an error. This also keeps teardown deterministic and the
 * relay's channel entry from lingering (closing a writable always emits the reset;
 * a half-close that relied on `ReadableStream.cancel()` did not).
 *
 * Browser-safe: pure TypeBox schemas, no node builtin, so the client transport
 * (`packages/workspace/src/relay-channel/`) and the server router
 * (`packages/server/src/room/channel-router.ts`) share one source of truth. It
 * replaces the former in-room dispatch protocol, which routed `action`/`input`
 * and a typed `Result` the relay had to understand; this one is a dumb byte
 * pipe.
 *
 * Minimal on purpose: `channel_data.bytes` is the whole payload (no `seq`, since
 * one ordered WebSocket preserves order end to end), and the caller's open
 * carries no `source`: the relay stamps an unforgeable one it authenticated, and
 * the acceptor authorizes by it (see {@link ChannelSourceSchema}).
 */

import Type, { type Static } from 'typebox';
import { Compile } from 'typebox/compile';

// ════════════════════════════════════════════════════════════════════════════
// FRAME SCHEMAS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Who opened a channel, as the RELAY authenticated them. The relay stamps this
 * onto the open it forwards from the caller's `Connection.userId` and overwrites
 * any caller-provided value, so the device acceptor can authorize a keyless
 * caller by its server-authenticated identity. `kind` is a discriminant kept
 * open for forward compatibility; today the only source the relay stamps is
 * `user`.
 */
export const ChannelSourceSchema = Type.Object({
	kind: Type.Literal('user'),
	userId: Type.String(),
});
export type ChannelSource = Static<typeof ChannelSourceSchema>;

/**
 * Caller -> relay -> target: open a channel `id` to device `target` on its named
 * `route`. The caller omits `source`; the relay validates `target` is a live
 * same-owner device, stamps the server-authored `source`, and forwards the
 * frame. The target reads `route` to pick its local handler and `source` to
 * authorize the open (the stdio route target has no header to carry a bearer, so
 * the acceptor IS the endpoint gate on the relay path).
 */
export const ChannelOpenFrameSchema = Type.Object({
	type: Type.Literal('channel_open'),
	id: Type.String(),
	target: Type.String(),
	route: Type.String(),
	source: Type.Optional(ChannelSourceSchema),
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

/**
 * Why a channel ended. It is the terminal frame in both directions: `closed` is
 * a clean end, the rest are failures. `offline` (relay: no live target socket)
 * and `refused` (target: route unknown or policy) are the open-time outcomes;
 * `cancelled` (a side aborted), `too_large` (a chunk past the socket ceiling),
 * and `protocol_error` (a malformed frame) end an established channel.
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
