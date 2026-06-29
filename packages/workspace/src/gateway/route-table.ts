/**
 * The named, default-closed route table the daemon serves over the relay floor.
 *
 * The table IS the exposure decision (the collapsed "Ring 1"): the relay
 * acceptor admits an inbound channel only for a route that exists in the table
 * AND is `relay: 'exposed'`, and the relay router carries nothing else. There is
 * no generic reverse proxy and no route negotiation envelope on the wire; the
 * named route rides the relay-channel `channel_open` frame.
 */

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import type { ByteChannel } from '../peer-transport.js';

/**
 * The default served route table: one `books` route that spawns `local-books
 * mcp`. The command is caller-data, so the workspace package never imports
 * `@epicenter/local-books`; the operator must have `local-books` on PATH.
 *
 * The route stays `relay: 'refused'` by default; the daemon opts it in with
 * `--relay-expose books`, so its financial data is reachable over the relay
 * floor only once the operator knowingly accepts that ceiling (a self-hosted
 * relay removes the third party; ADR-0068).
 */
export const DEFAULT_DEVICE_ROUTES: RouteTable = {
	books: { command: 'local-books', args: ['mcp'] },
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
 *
 * `relay` is the relay-floor exposure policy (default `refused`): whether this
 * route is reachable over the relay floor at all, where the caller is a
 * server-authenticated USER (the relay stamps an unforgeable `source.userId`). A
 * sensitive route (financial, a shell) stays `refused`; a route author opts one
 * IN with `relay: 'exposed'`, knowingly accepting the relay floor's
 * trusted-relay ceiling (a self-hosted relay removes the third party; ADR-0068).
 */
export type SpawnRoute = {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
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

/** A named set of routes; the keys are route names. */
export type RouteTable = Record<string, Route>;

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

/** A live local route target: its byte channel plus a teardown handle. */
export type RouteTarget = { channel: ByteChannel; close(): void };

/**
 * Open the local target for a route and return its {@link ByteChannel}. The
 * relay acceptor dumb-pipes the inbound relay channel to this channel and back.
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
