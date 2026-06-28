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
import type { TrustState } from '../account/reducer.js';
import type { ByteChannel, RouteName } from './transport.js';
import { asRouteName } from './transport.js';

/**
 * The minimum trust a peer must hold to reach a route: the per-route sensitivity
 * policy (the spec's "tool sensitivity is a policy, not a stored state"). A
 * low-risk route accepts a merely-`listed` peer; a sensitive route (like
 * local-books) requires a human-confirmed `verified` peer. `revoked` peers never
 * meet any threshold. There is no `revoked` threshold because no route is
 * reachable only by revoked peers.
 */
export type RouteTrustThreshold = 'listed' | 'verified';

/** Numeric trust rank; a peer reaches a route iff its rank ≥ the threshold's. */
const TRUST_RANK: Record<TrustState, number> = {
	revoked: 0,
	listed: 1,
	verified: 2,
};

/**
 * Whether a peer in trust state `state` meets a route's `requires` threshold.
 * `revoked` (rank 0) meets nothing; `listed` clears a `listed` route; `verified`
 * clears both. A peer the reducer has never listed has no state at all, which the
 * gateway treats as below `listed` (refused) before this is consulted.
 */
export function meetsTrustThreshold(
	state: TrustState,
	requires: RouteTrustThreshold,
): boolean {
	return TRUST_RANK[state] >= TRUST_RANK[requires];
}

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
 *
 * `requires` is the route's sensitivity policy (default `verified`, the safe
 * choice: a route author opts DOWN to `listed` for a low-risk tool, never up by
 * forgetting a field).
 */
export type SpawnRoute = {
	kind: 'spawn';
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	requires?: RouteTrustThreshold;
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

/** A route's effective trust threshold, defaulting to the safe `verified`. */
export function routeTrustThreshold(route: Route): RouteTrustThreshold {
	return route.requires ?? 'verified';
}

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
