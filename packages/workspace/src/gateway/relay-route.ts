/**
 * The daemon's relay-floor route opener: the endpoint gate on the relay path.
 *
 * The relay-channel acceptor ({@link ../relay-channel/acceptor}) is mechanism; it
 * holds no policy and pipes whatever this opener admits. ALL relay-path
 * authorization lives here, the relay equivalent of the iroh gateway's Ring 0
 * (`gateway.ts` `handleIncoming`): admit an inbound channel only when
 *
 *   - the relay-authored `source` is a `user` that is THIS daemon's own owner
 *     (the relay authenticated it; a keyless caller cannot forge it), and
 *   - the named route is explicitly `relay: 'exposed'` (default refused), so a
 *     sensitive route (financial, a shell) stays iroh-only.
 *
 * NODE-ONLY: it spawns the route child via {@link openRouteTarget}. The daemon
 * injects it into the browser-safe acceptor, so the acceptor itself stays free of
 * `node:child_process`.
 */

import type { RouteOpener } from '../relay-channel/acceptor.js';
import {
	openRouteTarget,
	type RouteTable,
	routeRelayExposed,
} from './route-table.js';

export type RelayRouteOpenerOptions = {
	/** The named, default-closed route table this daemon serves. */
	routes: RouteTable;
	/** This daemon's authenticated account owner; the only `source.userId` admitted. */
	ownerUserId: string;
};

/** Build the relay-path {@link RouteOpener} that gates inbound channels for a daemon. */
export function createRelayRouteOpener(
	options: RelayRouteOpenerOptions,
): RouteOpener {
	const { routes, ownerUserId } = options;
	return ({ route, source }) => {
		// The caller must be this owner, as the relay authenticated them.
		if (source?.kind !== 'user' || source.userId !== ownerUserId) return null;
		// The route must exist AND be opted in to the relay floor.
		const target = routes[route];
		if (!target || !routeRelayExposed(target)) return null;
		return openRouteTarget(target);
	};
}
