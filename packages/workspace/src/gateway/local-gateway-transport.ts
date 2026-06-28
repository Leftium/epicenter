/**
 * Impl #1 of the {@link ./transport.PeerTransport} seam: dial through the LOCAL
 * daemon gateway, which owns the iroh endpoint.
 *
 * This is the only transport built in this landing. The consumer (the agent
 * loop's MCP-client `ToolCatalog` arm, Wave 5) holds a `PeerTransport` and
 * never learns it is iroh underneath. Impl #2 (in-process WASM iroh in a
 * browser peer, Vision C) slots in behind the same interface without touching
 * the consumer.
 *
 * NODE-ONLY (it references {@link ./gateway.PeerGateway}, which owns iroh).
 */

import type { PeerGateway } from './gateway.js';
import type { PeerTransport } from './transport.js';

/** Wrap a local {@link PeerGateway} as a {@link PeerTransport}. */
export function createLocalGatewayTransport(
	gateway: PeerGateway,
): PeerTransport {
	return {
		openChannel: (options) => gateway.dial(options),
	};
}
