/**
 * ONE {@link PeerTransport} seam over the two transports the system has: the
 * relay floor and iroh-direct. The consumer (the agent loop's MCP-client
 * `ToolCatalog` arm) holds this and never learns which carried its bytes.
 *
 * Selection rule (the [collapse spec]'s "one client seam, two transports"): the
 * relay floor is the universal FLOOR, iroh-direct a native OPTIMIZATION. So
 * `auto` uses iroh when this client has it AND the target is reachable over it,
 * and falls back to the relay floor both when iroh is absent (a browser) and when
 * an iroh dial fails (the target is unreachable over iroh). `prefer` forces one
 * transport, the override step 6 uses to measure iroh against the floor with the
 * same call shape, and a self-hoster uses to pin the floor at their own relay.
 *
 * Browser-safe: it only composes two `PeerTransport`s; a browser passes just the
 * relay (no iroh), a native daemon passes both.
 */

import type {
	ByteChannel,
	OpenChannelOptions,
	PeerTransport,
} from './peer-transport.js';

/** Which transport a selecting transport uses. `auto` applies the selection rule. */
export type TransportPreference = 'auto' | 'iroh' | 'relay';

export type SelectingTransportOptions = {
	/** The native iroh transport, present when this client owns a device gateway. */
	iroh?: PeerTransport;
	/** The relay-floor transport, present when this client holds an account-room connection. */
	relay?: PeerTransport;
	/** `auto` (default) applies the selection rule; `iroh`/`relay` force one. */
	prefer?: TransportPreference;
};

/** Compose iroh and the relay floor into one {@link PeerTransport} behind the selection rule. */
export function createSelectingTransport(
	options: SelectingTransportOptions,
): PeerTransport {
	const { iroh, relay, prefer = 'auto' } = options;
	if (!iroh && !relay) {
		throw new Error('createSelectingTransport: no transport provided');
	}

	const requireIroh = (): PeerTransport => {
		if (!iroh) throw new Error('iroh transport is not available on this client');
		return iroh;
	};
	const requireRelay = (): PeerTransport => {
		if (!relay) throw new Error('relay transport is not available on this client');
		return relay;
	};

	return {
		async openChannel(opts: OpenChannelOptions): Promise<ByteChannel> {
			if (prefer === 'iroh') return requireIroh().openChannel(opts);
			if (prefer === 'relay') return requireRelay().openChannel(opts);

			// auto: iroh is the optimization, the floor is the fallback. With both,
			// try iroh and fall back to the floor when the dial fails (the target is
			// unreachable over iroh); with only one, use it.
			if (iroh && relay) {
				try {
					return await iroh.openChannel(opts);
				} catch {
					return relay.openChannel(opts);
				}
			}
			// Exactly one transport is present here (the constructor refused neither).
			return (iroh ?? requireRelay()).openChannel(opts);
		},
	};
}
