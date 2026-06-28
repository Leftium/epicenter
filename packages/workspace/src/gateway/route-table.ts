/**
 * The named, default-closed route table the gateway forwards to.
 *
 * The route name IS the iroh ALPN, so route selection happens during the QUIC
 * handshake with no bespoke envelope on the wire (honoring ADR-0073: over iroh
 * there is no `{ to: nodeId }` wrapper and no dispatch protocol). A dialer asks
 * for a route by negotiating its ALPN; the gateway advertises only the ALPNs
 * for routes it actually exposes, so an unlisted route fails negotiation before
 * a byte flows. What the table contains is the exposure decision (the collapsed
 * "Ring 1"); there is no generic reverse proxy.
 */

import { spawn } from 'node:child_process';
import type { ByteChannel, RouteName } from './transport.js';
import { asRouteName } from './transport.js';

/**
 * A spawn route: the gateway runs a stdio child and dumb-pipes the inbound
 * bi-stream to its stdio. The child is warm for the lifetime of the held
 * connection and reused across every MCP call within it, which is the deletion
 * of the per-call spawn (one child serves one held session, not one per
 * `tools/call`).
 *
 * The command/args/cwd/env are caller-supplied so the gateway never depends on
 * any executor: the daemon wires `{ command: 'local-books', args: ['mcp'], ... }`
 * without `@epicenter/workspace` ever importing `@epicenter/local-books`.
 */
export type SpawnRoute = {
	kind: 'spawn';
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
};

/**
 * A route the gateway exposes. Today only {@link SpawnRoute} exists; a
 * `{ kind: 'service'; host; port }` variant (a `net.connect` dumb-pipe to a
 * local service port like `127.0.0.1:8000`) lands in Wave 5 alongside the
 * localhost-forward consumer that exercises it. The union is shaped so adding
 * it does not reshape callers.
 */
export type Route = SpawnRoute;

/** A named set of routes; the keys are {@link RouteName}s. */
export type RouteTable = Record<string, Route>;

const ALPN_PREFIX = 'epicenter/route/';

/** The ALPN bytes a dialer negotiates to reach the given route. */
export function alpnForRoute(route: RouteName): number[] {
	return [...Buffer.from(ALPN_PREFIX + route)];
}

/**
 * Recover the route name from a negotiated ALPN, or `null` if the bytes are not
 * one of ours (which cannot happen for an accepted connection, since the
 * gateway only advertises its own routes' ALPNs, but is checked defensively).
 */
export function routeNameForAlpn(alpn: number[]): RouteName | null {
	const text = Buffer.from(alpn).toString();
	if (!text.startsWith(ALPN_PREFIX)) return null;
	return asRouteName(text.slice(ALPN_PREFIX.length));
}

/** The advertised ALPNs for a whole table (what the endpoint binds). */
export function alpnsForTable(routes: RouteTable): number[][] {
	return Object.keys(routes).map((name) => alpnForRoute(asRouteName(name)));
}

/** A live local route target: its byte channel plus a teardown handle. */
export type RouteTarget = { channel: ByteChannel; close(): void };

/**
 * Open the local target for a route and return its {@link ByteChannel}. The
 * gateway dumb-pipes the inbound iroh bi-stream to this channel and back.
 */
export function openRouteTarget(route: Route): RouteTarget {
	const child = spawn(route.command, route.args ?? [], {
		cwd: route.cwd,
		env: route.env ? { ...process.env, ...route.env } : process.env,
		// stdin/stdout are the MCP channel; stderr is inherited for diagnostics.
		stdio: ['pipe', 'pipe', 'inherit'],
	});
	return {
		channel: { source: child.stdout!, sink: child.stdin! },
		close: () => {
			try {
				child.kill();
			} catch {
				// already exited
			}
		},
	};
}
