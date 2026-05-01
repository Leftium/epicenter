/**
 * Hono app for the `epicenter up` daemon. Single source of truth for the
 * routes; the server (`bindUnixSocket`) wires this into Bun's listener
 * and the hand-rolled `daemonClient` in `./client.ts` POSTs against it.
 *
 * Each verb is a one-line shell shortcut for one daemon runtime primitive:
 *
 *   /peers  ->  runtime.peerDirectory.peers()                   all routes
 *   /list   ->  describeActions({ route: runtime.actions }) all routes
 *   /run    ->  invokeAction(...) | rpc.rpc(...)              route-routed
 *
 * Each route returns the handler's `Result<T, DomainErr>` body directly.
 * Unexpected exceptions propagate to Hono's default error handler (HTTP
 * 500), which the client maps to `DaemonError.HandlerCrashed`. There is
 * no second on-the-wire envelope: `Result<Result<...>, ...>` is gone.
 */

import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';
import { PeerIdentity } from '../document/peer-presence-defs.js';
import { describeActions } from '../shared/actions.js';
import { executeRun } from './run-handler.js';
import type { StartedDaemonRoute } from './types.js';

/**
 * Wire body for `/run`. The schema serves two roles:
 *
 *   1. Runtime validation at the daemon boundary via
 *      `@hono/standard-validator`. A stale CLI gets a typed 400 instead of a
 *      downstream cast failure.
 *   2. Compile-time inference for the hand-rolled client; both sides import
 *      the exact same shape.
 *
 * Naming follows arktype's idiom (one PascalCase name declares both the
 * value and the type).
 */

export const RunRequest = type({
	actionPath: 'string',
	input: 'unknown',
	'peerTarget?': 'string',
	waitMs: 'number',
});
export type RunRequest = typeof RunRequest.infer;

/**
 * Row shape returned by `/peers`. One row per `(route, clientID)` pair,
 * tagged with its route name so a multi-route daemon can fan out.
 * `peer` carries the canonical peer identity from the standard presence
 * convention; renderers consume it directly without a cast.
 */
export const PeerSnapshot = type({
	route: 'string',
	clientID: 'number',
	peer: PeerIdentity,
});
export type PeerSnapshot = typeof PeerSnapshot.infer;

/**
 * Build the daemon's Hono app. Tests import this directly; production wires
 * it into `Bun.serve({ unix, fetch: app.fetch })` via `bindUnixSocket`.
 *
 * `/list` exposes route-prefixed action paths. `/run` uses that same
 * prefix to pick the hosted daemon runtime before dispatching the inner action
 * path locally or over RPC.
 */
export function buildDaemonApp(
	runtimes: StartedDaemonRoute[],
	triggerShutdown?: () => void,
) {
	return new Hono()
		.post('/ping', (c) => c.json(Ok('pong' as const)))
		.post('/peers', (c) => {
			const rows: PeerSnapshot[] = [];
			for (const entry of runtimes) {
				const peers = entry.runtime.peerDirectory.peers();
				for (const [clientID, state] of peers) {
					rows.push({
						route: entry.route,
						clientID,
						peer: state.peer,
					});
				}
			}
			return c.json(Ok(rows));
		})
		.post('/list', (c) => {
			const actionRoots = Object.fromEntries(
				runtimes.map((entry) => [entry.route, entry.runtime.actions]),
			);
			return c.json(Ok(describeActions(actionRoots)));
		})
		.post('/run', sValidator('json', RunRequest), async (c) => {
			const request = c.req.valid('json');
			return c.json(await executeRun(runtimes, request));
		})
		.post('/shutdown', (c) => {
			setTimeout(() => triggerShutdown?.(), 0);
			return c.json(Ok(null));
		});
}

export function buildStartingDaemonApp() {
	return new Hono()
		.post('/ping', (c) => c.json(Ok('pong' as const)))
		.all('*', (c) => c.text('daemon routes are starting', 503));
}
