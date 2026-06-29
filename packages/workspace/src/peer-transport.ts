/**
 * The cross-device transport seam.
 *
 * A {@link PeerTransport} opens a raw byte channel to a named route on a remote
 * peer. It is the ONLY thing the cross-device tool layer (the agent loop's
 * MCP-client `ToolCatalog` arm) sees: it never learns whether the bytes travel
 * over the relay floor (a channel multiplexed on the account-room WebSocket) or
 * over a direct iroh peer link.
 *
 * Two implementations sit behind this seam (the [collapse spec]'s "one client
 * seam, two transports"):
 *   - the relay-channel, the universal FLOOR: works in any browser with no app,
 *     server-mediated over the device's existing sync connection.
 *   - iroh-direct, a native-only optimization: dial through the LOCAL daemon
 *     gateway, which owns the iroh endpoint
 *     ({@link ./gateway/local-gateway-transport.createLocalGatewayTransport}).
 *
 * The seam is the {@link ByteChannel}, which is intentionally runtime-portable
 * (Web Streams, not node streams) so the same seam serves a browser and a node
 * daemon. Do not hardcode "iroh is reached via localhost" above this interface,
 * or the browser-relay case becomes a rewrite instead of a second impl.
 *
 * A *peer* is the unit that is enrolled/dialed: a native daemon gateway holding
 * an iroh keypair, or a browser client authenticated to the relay as its user. A
 * browser tab on a machine that already runs a daemon may instead reach that
 * daemon over localhost and borrow its identity.
 */

import type { Brand } from 'wellcrafted/brand';

/**
 * The two halves of a bidirectional byte channel, as Web Streams so one shape
 * serves both runtimes: `ReadableStream`/`WritableStream` are globals in modern
 * browsers and in Node 18+. The relay-channel transport builds these from the
 * account-room WebSocket frames; the iroh adapter ({@link
 * ./gateway/iroh-channel.biStreamToByteChannel}) builds them from an iroh
 * bi-stream, and the route table builds them from a child's stdio via
 * `Readable.toWeb`/`Writable.toWeb`. An MCP transport written against `{ source,
 * sink }` ({@link ./mcp-stream-transport.createStreamTransport}) rides any of
 * them unchanged.
 */
export type ByteChannel = {
	source: ReadableStream<Uint8Array>;
	sink: WritableStream<Uint8Array>;
};

/**
 * A peer's stable identity: its iroh `EndpointId` in base32 string form. This
 * is the durable public key, not a claimed nanoid; it is the Ring-0 allowlist
 * key and the routing label.
 */
export type PeerId = string & Brand<'PeerId'>;

/** Syntactic sugar for `value as PeerId`; the only sanctioned `as PeerId`. */
export const asPeerId = (value: string): PeerId => value as PeerId;

/**
 * A named, allowlisted route on a peer's gateway (`books`, `whisper`, ...). The
 * route table is default-closed: nothing outside it is reachable, and the name
 * is negotiated as the iroh ALPN, so an unlisted route fails the QUIC handshake
 * before a byte flows.
 */
export type RouteName = string & Brand<'RouteName'>;

/** Syntactic sugar for `value as RouteName`; the only sanctioned `as RouteName`. */
export const asRouteName = (value: string): RouteName => value as RouteName;

/** Inputs to {@link PeerTransport.openChannel}. */
export type OpenChannelOptions = {
	/** The remote peer to reach. */
	target: PeerId;
	/** The named route on the remote peer's gateway. */
	route: RouteName;
	/**
	 * Direct dial hints (`ip:port`), optional. The daemon transport is `n0`, so
	 * iroh discovery resolves the peer by its peerId (its `EndpointId`, the very
	 * id the roster stores) and a discovery transport ignores these. They remain a
	 * same-LAN / `minimal`-preset fast path: a direct-only transport needs an
	 * address because it cannot discover one. There is no synced `addr` field.
	 */
	hintAddrs?: string[];
	/**
	 * Abort the open. Aborting closes the underlying connection the transport
	 * opened, even if the open resolves after the abort fires, so a caller that
	 * times the open out (a Ring-0 refusal hangs the MCP handshake) does not leak
	 * the connection.
	 */
	signal?: AbortSignal;
};

/**
 * The transport-blind seam: open a {@link ByteChannel} to a route on a remote
 * peer. The consumer layers an MCP session (or any byte protocol) on top; it
 * never sees iroh, ALPNs, allowlists, or NAT traversal.
 */
export interface PeerTransport {
	openChannel(options: OpenChannelOptions): Promise<ByteChannel>;
}
