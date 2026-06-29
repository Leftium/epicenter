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
import { Readable, Writable } from 'node:stream';
import type { TrustState } from '../account/reducer.js';
import type { ByteChannel, RouteName } from '../peer-transport.js';
import { asRouteName } from '../peer-transport.js';

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
 * `requires` is the route's iroh sensitivity policy (default `verified`, the safe
 * choice: a route author opts DOWN to `listed` for a low-risk tool, never up by
 * forgetting a field).
 *
 * `relay` is the SEPARATE relay-floor policy (default `refused`): whether this
 * route is reachable over the relay floor at all, where the caller is a
 * server-authenticated USER, not a device-key-trusted peer. It is not `requires`,
 * because a keyless browser user can never meet a device-key threshold. A
 * sensitive route (financial, a shell) stays `refused` and is iroh-only; a route
 * author opts a low-risk route IN with `relay: 'exposed'`, knowingly accepting
 * the relay floor's trusted-relay ceiling (a self-hosted relay removes the third
 * party; ADR-0068).
 */
export type SpawnRoute = {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	requires?: RouteTrustThreshold;
	relay?: 'exposed' | 'refused';
};

/**
 * A route the gateway exposes. Today there is one route shape, {@link
 * SpawnRoute}. A `service` variant (a `net.connect` dumb-pipe to a local service
 * port like `127.0.0.1:8000`) lands in Wave 5 alongside the localhost-forward
 * consumer that exercises it; introducing it reintroduces a `kind` discriminant
 * across the variants.
 */
export type Route = SpawnRoute;

/** A named set of routes; the keys are {@link RouteName}s. */
export type RouteTable = Record<string, Route>;

/** A route's effective trust threshold, defaulting to the safe `verified`. */
export function routeTrustThreshold(route: Route): RouteTrustThreshold {
	return route.requires ?? 'verified';
}

/** Whether a route is reachable over the relay floor (default `refused`). */
export function routeRelayExposed(route: Route): boolean {
	return route.relay === 'exposed';
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
		// Adapt the child's stdio to the seam's {@link ByteChannel} shape so the
		// route target speaks the same Web Streams as an iroh bi-stream and the
		// relay channel. The node-to-web bridge (and its one type cast) is named
		// and contained below.
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

/**
 * The one home for the node-stdio to Web-Streams bridge.
 *
 * `Readable.toWeb` / `Writable.toWeb` do the real conversion (with backpressure),
 * but `@types/node` types them against node's `stream/web` `ReadableStream`, a TS
 * type distinct from the global Web Streams the {@link ByteChannel} seam is typed
 * against even though Bun makes them one runtime object. That nominal gap is the
 * only reason a cast exists; naming it here keeps the seam's call sites clean and
 * gives the interop a single documented place to live.
 */
function nodeReadableToWeb(readable: Readable): ReadableStream<Uint8Array> {
	return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>;
}

function nodeWritableToWeb(writable: Writable): WritableStream<Uint8Array> {
	return Writable.toWeb(writable) as unknown as WritableStream<Uint8Array>;
}
