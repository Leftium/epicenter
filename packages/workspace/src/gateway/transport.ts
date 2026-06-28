/**
 * The cross-device transport seam.
 *
 * A {@link PeerTransport} opens a raw byte channel to a named route on a remote
 * peer. It is the ONLY thing the cross-device tool layer (the agent loop's
 * MCP-client `ToolCatalog` arm, Wave 5) sees: it never learns whether the bytes
 * travel over iroh directly, over a localhost forward to a daemon that owns
 * iroh, or (later) over an in-process WASM iroh endpoint inside a browser.
 *
 * Two implementations are planned, one built:
 *   - Impl #1 (this landing): dial through the LOCAL daemon gateway, which owns
 *     the iroh endpoint ({@link ./local-gateway-transport.createLocalGatewayTransport}).
 *   - Impl #2 (Vision C, NOT built): in-process WASM iroh in a browser peer.
 *
 * The seam is the {@link ByteChannel}; transport selection lives behind it. Do
 * not hardcode "iroh is reached via localhost" above this interface, or the
 * phone/WASM case becomes a rewrite instead of a second impl.
 *
 * A *peer* is the unit that holds an iroh keypair and is enrolled/dialed: a
 * native daemon gateway today, a WASM-iroh browser later. A browser tab on a
 * machine that already runs a daemon is a *client* of that daemon over
 * localhost, not a separately-enrolled peer: it borrows its daemon's identity.
 */

import type { Readable, Writable } from 'node:stream';
import type { Brand } from 'wellcrafted/brand';

/**
 * The two halves of a bidirectional byte channel. iroh's `connection.openBi()`
 * hands you exactly this (a `SendStream` sink and a `RecvStream` source) and
 * stdio is the same shape, so an MCP transport written against `{ source, sink }`
 * rides an iroh bi-stream, a child's stdio, or an in-memory pipe unchanged.
 */
export type ByteChannel = { source: Readable; sink: Writable };

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
	 * Direct dial hints (`ip:port`). Wave 4's synced device roster resolves
	 * these from the trust ledger; until then the caller supplies them. A
	 * transport that resolves addresses itself (relay/discovery) ignores them.
	 */
	hintAddrs?: string[];
};

/**
 * The transport-blind seam: open a {@link ByteChannel} to a route on a remote
 * peer. The consumer layers an MCP session (or any byte protocol) on top; it
 * never sees iroh, ALPNs, allowlists, or NAT traversal.
 */
export interface PeerTransport {
	openChannel(options: OpenChannelOptions): Promise<ByteChannel>;
}
