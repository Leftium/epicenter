/**
 * Wire the device's relay-floor acceptor: accept inbound relay channels over the
 * account-room socket and serve them from the daemon's route table. It is the
 * device's accept loop, riding the connection the account room already holds.
 *
 * The endpoint gate (the caller must be this owner, the route must be explicitly
 * `relay: 'exposed'`) lives in {@link createRelayRouteOpener}; the acceptor is
 * pure mechanism. By default the route table exposes NOTHING over the relay (the
 * `books` route is `refused`), so this is safe to wire unconditionally: the
 * device participates in the floor but admits a route only once one opts in.
 *
 * NODE-ONLY: the route opener spawns route children.
 */

import { createLogger, type Logger } from 'wellcrafted/logger';
import {
	createRelayRouteOpener,
	type RouteTable,
	routeRelayExposed,
} from '../gateway/index.js';
import {
	type ChannelPort,
	createChannelAcceptor,
} from '../relay-channel/index.js';

export type OpenRelayAcceptorOptions = {
	/** The relay-channel port over the account-room socket. */
	channelPort: ChannelPort;
	/** The served route table. */
	routes: RouteTable;
	/** This daemon's authenticated account owner; the only caller admitted. */
	ownerUserId: string;
	logger?: Logger;
};

export type RelayAcceptorHandle = {
	/** Detach from the account-room port and tear down any live route children. */
	close(): void;
};

/** Start accepting relay-floor channels for the daemon. Synchronous; never throws. */
export function openRelayAcceptor(
	options: OpenRelayAcceptorOptions,
): RelayAcceptorHandle {
	const {
		channelPort,
		routes,
		ownerUserId,
		logger = createLogger('workspace/relay-acceptor'),
	} = options;

	const acceptor = createChannelAcceptor(
		channelPort,
		createRelayRouteOpener({ routes, ownerUserId }),
	);

	const exposed = Object.keys(routes).filter((name) =>
		routeRelayExposed(routes[name]!),
	);
	logger.info('relay acceptor listening', { exposedRoutes: exposed });

	return { close: () => acceptor.close() };
}
