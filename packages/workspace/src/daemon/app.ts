/**
 * Hono app for the `epicenter up` daemon. Single source of truth for the
 * routes; the server (`bindUnixSocket`) wires this into Bun's listener
 * and the hand-rolled `daemonClient` in `./client.ts` POSTs against it.
 *
 * Each verb is a one-line shell shortcut for one workspace primitive:
 *
 *   /peers  ->  workspace.presence.peers()                    all exports
 *   /list   ->  describeActions({ export: workspace.actions }) all exports
 *   /run    ->  invokeAction(...) | rpc.rpc(...)              export-routed
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
import { Peer } from '../document/standard-awareness-defs.js';
import { describeActions } from '../shared/actions.js';
import { executeRun } from './run-handler.js';
import type { WorkspaceEntry } from './types.js';

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
 * Row shape returned by `/peers`. One row per `(exportName, clientID)` pair,
 * tagged with its config export name so a multi-export daemon can fan out.
 * `peer` carries the canonical peer descriptor from the standard awareness
 * convention; renderers consume it directly without a cast.
 */
export const PeerSnapshot = type({
	exportName: 'string',
	clientID: 'number',
	peer: Peer,
});
export type PeerSnapshot = typeof PeerSnapshot.infer;

/**
 * Build the daemon's Hono app. Tests import this directly; production wires
 * it into `Bun.serve({ unix, fetch: app.fetch })` via `bindUnixSocket`.
 *
 * `/list` exposes export-prefixed action paths. `/run` uses that same
 * prefix to pick the workspace export before dispatching the inner action
 * path locally or over RPC.
 */
export function buildApp(
	entries: WorkspaceEntry[],
	triggerShutdown?: () => void,
) {
	return new Hono()
		.post('/ping', (c) => c.json(Ok('pong' as const)))
		.post('/peers', (c) => {
			const rows: PeerSnapshot[] = [];
			for (const entry of entries) {
				const peers = entry.workspace.presence?.peers() ?? new Map();
				for (const [clientID, state] of peers) {
					rows.push({
						exportName: entry.name,
						clientID,
						peer: state.peer,
					});
				}
			}
			return c.json(Ok(rows));
		})
		.post('/list', (c) => {
			const actionRoots = Object.fromEntries(
				entries.map((entry) => [entry.name, entry.workspace.actions]),
			);
			return c.json(Ok(describeActions(actionRoots)));
		})
		.post('/run', sValidator('json', RunRequest), async (c) => {
			const request = c.req.valid('json');
			return c.json(await executeRun(entries, request));
		})
		.post('/shutdown', (c) => {
			setTimeout(() => triggerShutdown?.(), 0);
			return c.json(Ok(null));
		});
}
