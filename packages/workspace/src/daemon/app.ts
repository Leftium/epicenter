/**
 * Hono app for the `epicenter daemon up` daemon. Single source of truth for the
 * routes; the daemon server wires its fetch handler into Bun's listener and
 * the hand-rolled `daemonClient` in `./client.ts` POSTs against it.
 *
 * Each verb is a one-line shell shortcut for one daemon runtime primitive:
 *
 *   /peers  ->  collaboration.peers.list()                       all routes
 *   /list   ->  flat manifest of `${route}.${action_key}` -> meta  all routes
 *   /run    ->  invokeAction(...) | collab.dispatch(...)          route-routed
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
import {
	type ActionManifest,
	type ActionRegistry,
	toActionMeta,
} from '../shared/actions.js';
import { executeRun, type DaemonRunRoute } from './run-handler.js';

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
 * Row shape returned by `/peers`. One row per `(route, connId)` pair,
 * tagged with its route name so a multi-route daemon can fan out.
 *
 * `subject` is the server-attested user id; `replicaId` is the install-stable,
 * client-claimed identity; `connId` is the per-socket routing address used
 * by `collab.dispatch({ to })`.
 */
export const PeerSnapshot = type({
	route: 'string',
	connId: 'string',
	replicaId: 'string',
	subject: 'string',
});
export type PeerSnapshot = typeof PeerSnapshot.infer;

/**
 * Route plus action registry, the only data `/list` needs.
 *
 * This makes manifest projection a single production helper instead of a Hono
 * route behavior duplicated in tests. The daemon app maps full runtimes down
 * to this shape before projection.
 */
export type RouteActionSource = {
	route: string;
	actions: ActionRegistry;
};

/**
 * Build the route-qualified daemon action manifest.
 *
 * `/list` and its tests both use this helper, so the action prefix rule has one
 * source of truth: `${route}.${actionKey}`. The Hono route only handles request
 * and response plumbing.
 */
export function createRouteActionManifest(
	routes: readonly RouteActionSource[],
): ActionManifest {
	const manifest: ActionManifest = {};
	for (const entry of routes) {
		for (const [path, action] of Object.entries(entry.actions)) {
			manifest[`${entry.route}.${path}`] = toActionMeta(action);
		}
	}
	return manifest;
}

/**
 * Build the daemon's Hono app. Tests import this directly; production serves
 * the app through the daemon server factory.
 *
 * `/list` exposes route-qualified action keys. `/run` uses that same
 * prefix to pick the hosted daemon runtime before dispatching the action key
 * locally or over RPC.
 */
export function buildDaemonApp(
	runtimes: DaemonRunRoute[],
	triggerShutdown?: () => void,
) {
	return new Hono()
		.post('/ping', (c) => c.json(Ok('pong' as const)))
		.post('/peers', (c) => {
			const rows: PeerSnapshot[] = [];
			for (const entry of runtimes) {
				for (const peer of entry.runtime.collaboration.peers.list()) {
					rows.push({
						route: entry.route,
						connId: peer.connId,
						replicaId: peer.replicaId,
						subject: peer.subject,
					});
				}
			}
			return c.json(Ok(rows));
		})
		.post('/list', (c) => {
			return c.json(
				Ok(
					createRouteActionManifest(
						runtimes.map((entry) => ({
							route: entry.route,
							actions: entry.runtime.collaboration.actions,
						})),
					),
				),
			);
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
