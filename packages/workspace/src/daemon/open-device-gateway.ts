/**
 * Construct the device gateway on the daemon: the missing site that turns the
 * Wave 1 gateway primitive into a live endpoint.
 *
 * The daemon is the one process per device that owns the iroh endpoint
 * (ADR-0009). This module hands {@link createPeerGateway} the three things only
 * the daemon has: the device's durable secret (the SAME key the account room
 * signs with, loaded from {@link irohKeyPathFor}), the served route table (the
 * `books` route spawns `local-books mcp`), and the trust source (the account
 * room's reducer fold, re-read per inbound connection so a `verify`/`revoke` that
 * syncs in takes effect with no restart). It starts the accept loop and exposes
 * the dial side as a {@link PeerTransport}, the seam the cross-device tool layer
 * dials through.
 *
 * NODE-ONLY: it pulls in the iroh gateway. It is opened best-effort alongside the
 * account room (a signed-out daemon has neither), and only when an account room
 * exists, because without the trust fold there is nothing to gate Ring 0 on.
 */

import { createLogger, type Logger } from 'wellcrafted/logger';
import type { TrustState } from '../account/index.js';
import {
	createLocalGatewayTransport,
	createPeerGateway,
	loadOrCreateDeviceSecret,
	type PeerId,
	type PeerTransport,
	type RelayPreset,
	type RouteTable,
} from '../gateway/index.js';
import {
	type ChannelPort,
	createRelayChannelTransport,
	type RelayChannelTransport,
} from '../relay-channel/index.js';
import { createSelectingTransport } from '../select-transport.js';
import { irohKeyPathFor } from './paths.js';

/** The slice of the account room the gateway reads: per-peer trust for Ring 0. */
export type DeviceGatewayTrustSource = {
	trustState(): ReadonlyMap<PeerId, TrustState>;
};

/**
 * The default served route table: one `books` route that spawns `local-books
 * mcp`, gated at `verified` (its financial data demands a human-confirmed peer).
 * The command is caller-data, so the workspace package never imports
 * `@epicenter/local-books`; the operator must have `local-books` on PATH.
 */
export const DEFAULT_DEVICE_ROUTES: RouteTable = {
	books: { command: 'local-books', args: ['mcp'], requires: 'verified' },
};

export type OpenDeviceGatewayOptions = {
	/** The Epicenter root whose daemon owns this gateway (selects the keyfile). */
	epicenterRoot: string;
	/** Trust source for Ring 0; the account room satisfies this structurally. */
	trust: DeviceGatewayTrustSource;
	/** The served route table; defaults to {@link DEFAULT_DEVICE_ROUTES}. */
	routes?: RouteTable;
	/**
	 * The account-room channel port. When present, the dial-side `transport` is the
	 * SELECTING transport over iroh and the relay floor (iroh optimized, the floor
	 * as fallback), so this daemon's cross-device calls reach a target over either.
	 * Absent leaves the transport iroh-only.
	 */
	relayChannelPort?: ChannelPort;
	/**
	 * Transport reachability. Defaults to `n0`: iroh discovery resolves a peer by
	 * its roster peerId (which IS its iroh `EndpointId`), so cross-machine dialing
	 * needs no synced dial hints, no signed `addr` field, nothing beyond the roster
	 * the account doc already carries. `minimal` (direct, loopback/same-LAN) is a
	 * hermeticity seam for tests, never an operator mode: the daemon always runs
	 * `n0`, and there is no flag, env var, or config field to pick otherwise.
	 */
	relay?: RelayPreset;
	/** Bind address. Defaults to the gateway's own `127.0.0.1:0`. */
	bindAddr?: string;
	logger?: Logger;
};

/**
 * A live device gateway: this device's peerId, the dial-side transport, the
 * bound addresses other peers reach it at, and the disposer that closes the
 * endpoint and any live route children.
 */
export type DeviceGatewayHandle = {
	/** This device's peerId (its iroh public key). */
	peerId: PeerId;
	/** The dial-side seam the cross-device tool layer opens channels through. */
	transport: PeerTransport;
	/** The route names this gateway serves (for operator display). */
	routeNames(): string[];
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Build, bind, and start the device gateway, returning a handle. Throws if the
 * endpoint fails to bind; the daemon opens it best-effort, so a throw is logged
 * and the daemon keeps serving its mount and account room without cross-device
 * tools.
 */
export async function openDeviceGateway(
	options: OpenDeviceGatewayOptions,
): Promise<DeviceGatewayHandle> {
	const {
		epicenterRoot,
		trust,
		routes = DEFAULT_DEVICE_ROUTES,
		relay = 'n0',
		bindAddr,
		relayChannelPort,
		logger = createLogger('workspace/device-gateway'),
	} = options;

	const secret = loadOrCreateDeviceSecret(irohKeyPathFor(epicenterRoot));
	const gateway = await createPeerGateway({
		secret,
		routes,
		// Re-read per inbound connection: the gateway calls this on every accept,
		// so a verdict that syncs into the account room takes effect immediately.
		trust: (peerId) => trust.trustState().get(peerId),
		relay,
		...(bindAddr !== undefined && { bindAddr }),
		logger,
	});
	gateway.listen();

	// The dial-side seam: iroh alone, or the selecting transport over iroh and the
	// relay floor when an account-room port is available. The consumer (the MCP
	// catalog) never learns which carried its bytes.
	const irohTransport = createLocalGatewayTransport(gateway);
	let relayTransport: RelayChannelTransport | undefined;
	let transport: PeerTransport = irohTransport;
	if (relayChannelPort) {
		relayTransport = createRelayChannelTransport(relayChannelPort);
		transport = createSelectingTransport({
			iroh: irohTransport,
			relay: relayTransport,
		});
	}

	return {
		peerId: gateway.peerId,
		transport,
		routeNames: () => Object.keys(routes),
		async [Symbol.asyncDispose]() {
			// Detach the relay client before the account-room port goes away.
			relayTransport?.close();
			await gateway.close();
		},
	};
}
