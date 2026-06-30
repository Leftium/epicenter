/**
 * The named, default-closed route table the daemon serves over the relay floor.
 *
 * The table IS the exposure decision: the relay acceptor admits an inbound
 * channel only for a route that exists in the table AND is `relay: 'exposed'`,
 * and the relay router carries nothing else. There is
 * no generic reverse proxy and no route negotiation envelope on the wire; the
 * named route rides the relay-channel `channel_open` frame.
 */

import { spawn } from 'node:child_process';
import type { ByteChannel, RouteTarget } from '../peer-transport.js';
import {
	nodeReadableToWeb,
	nodeWritableToWeb,
} from './node-stream-bridge.js';

/**
 * The default served route table: one `books` route that spawns `local-books
 * mcp`. The command is caller-data, so the workspace package never imports
 * `@epicenter/local-books`; the operator must have `local-books` on PATH.
 *
 * The route is refused by default (no `relay`); the daemon opts it in with
 * `--relay-expose books`, so its financial data is reachable over the relay
 * floor only once the operator knowingly accepts that ceiling (a self-hosted
 * relay removes the third party; ADR-0068).
 */
export const DEFAULT_DEVICE_ROUTES: RouteTable = {
	books: { kind: 'spawn', command: 'local-books', args: ['mcp'] },
};

/**
 * The relay-floor exposure policy every route variant carries (default
 * `refused`): whether this route is reachable over the relay floor at all, where
 * the caller is a server-authenticated USER (the relay stamps an unforgeable
 * `source.userId`). A sensitive route (financial, a shell) stays `refused`; a
 * route author opts one IN with `relay: 'exposed'`, knowingly accepting the relay
 * floor's trusted-relay ceiling (a self-hosted relay removes the third party;
 * ADR-0068). It lives on the shared base, not a variant, so {@link
 * routeRelayExposed} and {@link withRelayExposed} stay branchless across kinds.
 */
type RouteRelayPolicy = {
	relay?: 'exposed';
};

/**
 * A spawn route: the gateway runs a stdio child and dumb-pipes the inbound
 * bi-stream to its stdio. The child is warm for the lifetime of the held
 * connection and reused across every MCP call within it, which is the deletion
 * of the per-call spawn (one child serves one held session, not one per
 * `tools/call`).
 *
 * The command/args/cwd/env are caller-supplied so the route table never depends
 * on any executor: the daemon wires `{ command: 'local-books', args: ['mcp'] }`
 * without `@epicenter/workspace` ever importing `@epicenter/local-books`.
 */
export type SpawnRoute = RouteRelayPolicy & {
	kind: 'spawn';
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
};

/**
 * A route the gateway exposes. Today the only kind is a {@link SpawnRoute} (a
 * stdio child speaking MCP): the relay floor carries tool routes and only tool
 * routes (ADR-0078). Movable compute (inference) is a URL-addressed
 * `Connection { baseUrl }` reached through the inference gateway, never a relay
 * route, so there is no second kind to tunnel. The `kind: 'spawn'` discriminant
 * stays on {@link SpawnRoute} as the named seam to add another kind the day one
 * earns its keep.
 */
export type Route = SpawnRoute;

/** A named set of routes; the keys are route names. */
export type RouteTable = Record<string, Route>;

/** Whether a route is reachable over the relay floor (default `refused`). */
export function routeRelayExposed(route: Route): boolean {
	return route.relay === 'exposed';
}

/**
 * The relay-exposed route names this device advertises in presence, under the
 * `spawn` bucket. Every relay route is an MCP server a peer auto-mounts as a tool
 * catalog (the floor carries tool routes only, ADR-0078), so there is one bucket
 * today; a refused route appears in none (it is not reachable over the floor at
 * all). The `{ spawn }` shape keeps presence discovery stable as the named seam to
 * carry a second kind the day {@link Route} grows one.
 */
export function exposedRoutesByKind(routes: RouteTable): {
	spawn: string[];
} {
	const spawn: string[] = [];
	for (const [name, route] of Object.entries(routes)) {
		if (routeRelayExposed(route)) spawn.push(name);
	}
	return { spawn };
}

/**
 * Return a route table with the named routes opted in to the relay floor. Used by
 * the daemon's `--relay-expose` knob to expose a route over the relay for a
 * two-machine smoke or a self-hoster who accepts the trusted-relay ceiling; an
 * unknown name is ignored (it cannot expose a route that does not exist).
 */
export function withRelayExposed(
	routes: RouteTable,
	names: readonly string[],
): RouteTable {
	const next: RouteTable = { ...routes };
	for (const name of names) {
		const route = next[name];
		if (route) next[name] = { ...route, relay: 'exposed' };
	}
	return next;
}

/**
 * Open the local target for a route and return its {@link ByteChannel}. The
 * relay acceptor dumb-pipes the inbound relay channel to this channel and back.
 * One kind today ({@link SpawnRoute}); the acceptor never learns the kind, it
 * only pipes the {@link ByteChannel} seam this produces.
 */
export function openRouteTarget(route: Route): RouteTarget {
	return openSpawnTarget(route);
}

/** Spawn the route's stdio child and adapt its stdio to a {@link ByteChannel}. */
function openSpawnTarget(route: SpawnRoute): RouteTarget {
	const child = spawn(route.command, route.args ?? [], {
		cwd: route.cwd,
		env: route.env ? { ...process.env, ...route.env } : process.env,
		// stdin/stdout are the MCP channel; stderr is inherited for diagnostics.
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	return {
		// Adapt the child's stdio to the seam's {@link ByteChannel} shape so the
		// route target speaks the same Web Streams as the relay channel. The
		// node-to-web bridge (and its one type cast) is named and contained below.
		channel: {
			source: nodeReadableToWeb(child.stdout!),
			sink: nodeWritableToWeb(child.stdin!),
		},
		close: () => {
			try {
				child.kill();
			} catch {
				// already exited
			}
		},
	};
}
