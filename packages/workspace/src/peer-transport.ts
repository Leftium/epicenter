/**
 * The cross-device transport seam.
 *
 * A {@link PeerTransport} opens a raw byte channel to a named route on a remote
 * peer. It is the ONLY thing the cross-device tool layer (the agent loop's
 * MCP-client `ToolCatalog` arm) sees: it never learns how the bytes travel, only
 * that they reach the named route.
 *
 * One implementation sits behind this seam today, the relay-channel
 * ({@link ./relay-channel/transport.createRelayChannelTransport}): the universal
 * floor, a channel multiplexed on the per-user account-room WebSocket, so it
 * works in any browser with no app, server-mediated over the device's existing
 * sync connection. The seam stays an interface so the MCP `ToolCatalog` consumer
 * (`agent/mcp-gateway-catalog.ts`) never imports the relay-channel implementation
 * or learns how a route is reached, only that the bytes arrive: it is the
 * browser-safe boundary between the tool layer and the transport.
 *
 * The seam is the {@link ByteChannel}, intentionally runtime-portable (Web
 * Streams, not node streams) so the same seam serves a browser and a node daemon.
 *
 * A *peer* is the unit that is dialed: a device authenticated to the relay as its
 * user. The relay routes by the target's nodeId and stamps an unforgeable
 * `source` on every channel, so a peer reaches another of its owner's devices
 * with no key exchange in between.
 */

import type { Brand } from 'wellcrafted/brand';
import type { NodeId } from './document/node-id.js';

/**
 * The two halves of a bidirectional byte channel, as Web Streams so one shape
 * serves both runtimes: `ReadableStream`/`WritableStream` are globals in modern
 * browsers and in Node 18+. The relay-channel transport builds these from the
 * account-room WebSocket frames, and the route table builds them from a child's
 * stdio via `Readable.toWeb`/`Writable.toWeb`. An MCP transport written against
 * `{ source, sink }` ({@link ./mcp-stream-transport.createStreamTransport}) rides
 * either unchanged.
 */
export type ByteChannel = {
	source: ReadableStream<Uint8Array>;
	sink: WritableStream<Uint8Array>;
};

/**
 * A live local route target: the {@link ByteChannel} a device opened for an
 * inbound channel, plus the teardown handle that closes it. The acceptor
 * (`relay-channel/acceptor.ts`) dumb-pipes an admitted channel to this; the
 * daemon's `gateway/route-table.ts` `openRouteTarget` produces it (a spawn
 * child's stdio or a service socket). It lives here, on the browser-safe seam,
 * so both sides share one definition without the acceptor importing the
 * node-only route table.
 */
export type RouteTarget = { channel: ByteChannel; close(): void };

/**
 * A named, allowlisted MCP tool route on a peer's gateway (`books`, ...). The
 * route table is default-closed: nothing outside it is reachable, and the name
 * rides the relay-channel `channel_open` frame, so a route the target has not
 * exposed over the relay is refused before a byte flows.
 */
export type RouteName = string & Brand<'RouteName'>;

/** Syntactic sugar for `value as RouteName`; the only sanctioned `as RouteName`. */
export const asRouteName = (value: string): RouteName => value as RouteName;

/** Inputs to {@link PeerTransport.openChannel}. */
export type OpenChannelOptions = {
	/** The remote peer to reach, identified by its {@link NodeId} (the relay routes to it). */
	target: NodeId;
	/** The named route on the remote peer's gateway. */
	route: RouteName;
	/**
	 * Abort the open. Aborting closes the underlying connection the transport
	 * opened, even if the open resolves after the abort fires, so a caller that
	 * times the open out (a refusal hangs the MCP handshake) does not leak the
	 * connection.
	 */
	signal?: AbortSignal;
};

/**
 * The transport-blind seam: open a {@link ByteChannel} to a route on a remote
 * peer. The consumer layers an MCP session (or any byte protocol) on top; it
 * never sees the relay, the channel frames, or how a route is gated.
 */
export interface PeerTransport {
	openChannel(options: OpenChannelOptions): Promise<ByteChannel>;
}
