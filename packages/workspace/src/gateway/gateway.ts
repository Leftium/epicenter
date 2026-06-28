/**
 * The device gateway: the one process per device that owns the iroh endpoint.
 *
 * It is the ADR-0009 mandatory daemon wearing one more hat (not a new noun): it
 * holds the device keypair, advertises a named route table as iroh ALPNs,
 * enforces the Ring-0 allowlist on every inbound connection before a byte
 * flows, and dumb-pipes admitted bi-streams to the local route target. On the
 * dialing side it exposes {@link PeerGateway.dial}, the primitive behind the
 * {@link ./transport.PeerTransport} seam.
 *
 * This module is NODE-ONLY: it imports `@number0/iroh` (a native dep) and
 * `node:child_process`, so it must stay out of the browser barrel and is
 * reached only through the `@epicenter/workspace/gateway` subpath. No app under
 * `apps/*` ever imports it; apps reach a gateway through the transport seam.
 *
 * The accept loop and Ring-0 check are lifted from the proven
 * `proto/super-chat-gateway-iroh` prototype; the route table and the dial-side
 * seam are the productization.
 */

import {
	Endpoint,
	EndpointAddr,
	EndpointId,
	RelayMode,
	type SecretKey,
	presetMinimal,
	presetN0,
} from '@number0/iroh';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type { TrustState } from '../account/reducer.js';
import { biStreamToByteChannel } from './iroh-channel.js';
import {
	alpnForRoute,
	alpnsForTable,
	meetsTrustThreshold,
	openRouteTarget,
	type RouteTable,
	type RouteTarget,
	routeNameForAlpn,
	routeTrustThreshold,
} from './route-table.js';
import {
	asPeerId,
	type ByteChannel,
	type PeerId,
	type RouteName,
} from './transport.js';

/**
 * Transport reachability knob. `minimal` is direct-only (no relay), correct for
 * loopback and same-LAN dialing where direct addresses are known. `n0` uses
 * n0's public relays + discovery for NAT traversal across networks. This is the
 * Wave 0 axis (does iroh hole-punch a real NAT or fall back to relay); it does
 * not change the gateway's shape, only its transport config.
 */
export type RelayPreset = 'minimal' | 'n0';

export type PeerGatewayOptions = {
	/** The device's durable identity (see {@link ./key-store.loadOrCreateDeviceSecret}). */
	secret: SecretKey;
	/** The named, default-closed route table this gateway exposes. */
	routes: RouteTable;
	/**
	 * Ring-0: a peer's current trust state, or `undefined` for a peer this account
	 * has never listed. Re-read on EVERY inbound connection so a mid-run `verify`
	 * or `revoke` in the account doc takes effect without a gateway restart. The
	 * gateway admits a connection iff the route the peer asked for has a threshold
	 * its state meets (`meetsTrustThreshold`), so a low-risk route accepts a
	 * `listed` peer while a sensitive one demands `verified`. This is Wave 4's
	 * replacement for Wave 1's static `() => Set<PeerId>`: the node side wires it
	 * to `accountRoom.trustState().get(peerId)`, the reducer's fold of the signed
	 * log, so authority comes from device signatures, never the relay.
	 */
	trust: (peerId: PeerId) => TrustState | undefined;
	/** Transport reachability preset. Defaults to `minimal`. */
	relay?: RelayPreset;
	/** Bind address. Defaults to `127.0.0.1:0` (ephemeral loopback port). */
	bindAddr?: string;
	/** Diagnostics sink. Defaults to a `workspace/gateway` logger. */
	logger?: Logger;
};

export type DialOptions = {
	/** The remote peer to reach. */
	target: PeerId;
	/** The named route on the remote peer's gateway. */
	route: RouteName;
	/** Direct dial hints (`ip:port`); required under the `minimal` preset. */
	hintAddrs?: string[];
};

export type PeerGateway = {
	/** This gateway's stable identity (its iroh public key, base32). */
	readonly peerId: PeerId;
	/** The bound socket addresses (`ip:port`) other peers dial directly. */
	boundSockets(): string[];
	/** This gateway's full iroh address, for discovery/ticket publication. */
	endpointAddr(): EndpointAddr;
	/** Start the inbound accept loop (Ring-0 + dumb-pipe to routes). Idempotent. */
	listen(): void;
	/** Dial a route on a remote peer and return the raw byte channel. */
	dial(options: DialOptions): Promise<ByteChannel>;
	/** Close the endpoint and tear down any live route children. */
	close(): Promise<void>;
};

/** Build and bind a {@link PeerGateway}. Call {@link PeerGateway.listen} to accept. */
export async function createPeerGateway(
	options: PeerGatewayOptions,
): Promise<PeerGateway> {
	const {
		secret,
		routes,
		trust,
		relay = 'minimal',
		bindAddr = '127.0.0.1:0',
		logger = createLogger('workspace/gateway'),
	} = options;

	const builder = Endpoint.builder();
	if (relay === 'n0') {
		presetN0(builder);
	} else {
		presetMinimal(builder);
		builder.relayMode(RelayMode.disabled());
	}
	builder.secretKey([...secret.toBytes()]);
	builder.alpns(alpnsForTable(routes));
	builder.bindAddr(bindAddr);

	const endpoint = await builder.bind();
	const peerId = asPeerId(secret.public().toString());

	/** Live route children, tracked so {@link close} can tear them down. */
	const targets = new Set<RouteTarget>();
	let listening = false;
	let onlinePromise: Promise<void> | undefined;

	/** For the `n0` preset, wait once for relay connectivity before dialing. */
	function ensureOnline(): Promise<void> {
		if (relay !== 'n0') return Promise.resolve();
		onlinePromise ??= endpoint.online();
		return onlinePromise;
	}

	async function handleIncoming(
		incoming: Awaited<ReturnType<Endpoint['acceptNext']>>,
	): Promise<void> {
		if (!incoming) return;
		try {
			const accepting = await incoming.accept();
			const connection = await accepting.connect();
			const remote = asPeerId(connection.remoteId().toString());

			// Route selection rides the negotiated ALPN, not a wire envelope. It is
			// known from the handshake before acceptBi, so its sensitivity policy
			// gates Ring 0 below, still BEFORE any byte flows.
			const routeName = routeNameForAlpn([...connection.alpn()]);
			const route = routeName ? routes[routeName] : undefined;
			if (!route) {
				logger.info('refused unknown route', { remote: remote.slice(0, 16) });
				connection.close(0n, [...Buffer.from('unknown route')]);
				return;
			}

			// Ring 0: re-read the peer's trust per connection so the latest verify or
			// revoke wins, then refuse anything that does not meet THIS route's
			// threshold BEFORE acceptBi/spawn. A peer the account has never listed
			// (`undefined`) is below `listed` and refused.
			const state = trust(remote);
			if (!state || !meetsTrustThreshold(state, routeTrustThreshold(route))) {
				logger.info('refused peer below route threshold', {
					remote: remote.slice(0, 16),
					route: routeName,
					state: state ?? 'unlisted',
				});
				connection.close(0n, [...Buffer.from('not enrolled')]);
				return;
			}

			logger.info('admitted peer', {
				remote: remote.slice(0, 16),
				route: routeName,
				state,
			});

			// acceptBi() resolves when the dialer opens its bi-stream (its first
			// MCP write); only then do we spawn the warm route child.
			const bi = await connection.acceptBi();
			const target = openRouteTarget(route);
			targets.add(target);

			// Dumb byte pipe: inbound iroh recv -> child stdin, child stdout ->
			// outbound iroh send. The gateway never parses the MCP frames.
			const wire = biStreamToByteChannel(bi);
			wire.source.pipe(target.channel.sink);
			target.channel.source.pipe(wire.sink);

			const teardown = () => {
				if (!targets.delete(target)) return;
				target.close();
			};
			wire.source.on('close', teardown);
			target.channel.source.on('close', teardown);
		} catch (error) {
			logger.warn(
				error instanceof Error
					? error
					: new Error(`gateway inbound connection error: ${String(error)}`),
			);
		}
	}

	return {
		peerId,
		boundSockets: () => endpoint.boundSockets(),
		endpointAddr: () => endpoint.addr(),

		listen() {
			if (listening) return;
			listening = true;
			void (async () => {
				for (;;) {
					let incoming: Awaited<ReturnType<Endpoint['acceptNext']>>;
					try {
						incoming = await endpoint.acceptNext();
					} catch {
						// Endpoint closed (close() was called): normal shutdown.
						break;
					}
					if (!incoming) break;
					// Handle concurrently so a slow session never blocks accept.
					void handleIncoming(incoming);
				}
			})();
		},

		async dial({ target, route, hintAddrs }) {
			await ensureOnline();
			const id = EndpointId.fromString(target);
			const addr = new EndpointAddr(id, null, hintAddrs ?? null);
			const connection = await endpoint.connect(addr, alpnForRoute(route));
			const bi = await connection.openBi();
			return biStreamToByteChannel(bi);
		},

		async close() {
			for (const target of targets) target.close();
			targets.clear();
			try {
				await endpoint.close();
			} catch {
				// already closed
			}
		},
	};
}
