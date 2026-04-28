/**
 * Hono app for the `epicenter up` daemon. Single source of truth for the
 * routes; both the server (`bindUnixSocket`) and the typed client
 * (`daemonClient` via `hc<DaemonApp>`) derive from {@link DaemonApp}.
 *
 * Each route returns `Result<T, SerializedError>` as the JSON body. Domain
 * errors flow through with HTTP 200 (callers narrow on `result.error.name`);
 * transport-level failures fall through to the client's `DaemonError`
 * synthesis. See `specs/20260426T235000-cli-up-long-lived-peer.md`
 * § "IPC wire protocol".
 */

import { sValidator } from '@hono/standard-validator';
import { PeerDevice } from '@epicenter/workspace';
import { type } from 'arktype';
import { Hono } from 'hono';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

import type { ListResult } from '../commands/list.js';
import type { RunResult } from '../commands/run.js';
import type { WorkspaceEntry } from '../load-config.js';
import { resolveEntry } from '../util/resolve-entry.js';
import { executeList, executeRun } from './handlers.js';
import {
	type ListCtx,
	listCtxSchema,
	peersArgsSchema,
	type RunCtx,
	runCtxSchema,
} from './schemas.js';
import type { SerializedError } from './unix-socket.js';

/**
 * Row shape returned by `/peers`. One row per `(workspace, clientID)` pair,
 * tagged with its workspace name so a multi-workspace daemon can fan out.
 * `device` carries the canonical `PeerDevice` shape from
 * `@epicenter/workspace`; renderers consume it directly without a cast.
 */
export const PeerSnapshot = type({
	workspace: 'string',
	clientID: 'number',
	device: PeerDevice,
});
export type PeerSnapshot = typeof PeerSnapshot.infer;

/**
 * Build the daemon's Hono app. Tests import this directly; production wires
 * it into `Bun.serve({ unix, fetch: app.fetch })` via `bindUnixSocket`.
 *
 * `triggerShutdown` is invoked from the `/shutdown` route after the response
 * is queued. We use `setTimeout(.., 0)` rather than `queueMicrotask` so the
 * response bytes hit the wire before the server begins teardown.
 */
export function buildApp(
	entries: WorkspaceEntry[],
	triggerShutdown: () => void,
) {
	const errFrom = (cause: unknown): SerializedError => ({
		name: cause instanceof Error ? cause.name : 'Error',
		message: extractErrorMessage(cause),
	});

	const lookup = (
		name: string | undefined,
	):
		| { ok: true; entry: WorkspaceEntry }
		| { ok: false; error: SerializedError } => {
		try {
			return { ok: true, entry: resolveEntry(entries, name) };
		} catch (cause) {
			return { ok: false, error: errFrom(cause) };
		}
	};

	return new Hono()
		.post('/ping', (c) =>
			c.json(Ok('pong' as const) satisfies Result<'pong', never>),
		)
		.post('/peers', sValidator('json', peersArgsSchema), (c) => {
			const { workspace } = c.req.valid('json');
			const rows: PeerSnapshot[] = [];
			for (const entry of entries) {
				if (workspace && entry.name !== workspace) continue;
				const peers = entry.workspace.sync?.peers() ?? new Map();
				for (const [clientID, state] of peers) {
					rows.push({
						workspace: entry.name,
						clientID,
						device: state.device,
					});
				}
			}
			return c.json(Ok(rows) satisfies Result<PeerSnapshot[], never>);
		})
		.post('/list', sValidator('json', listCtxSchema), async (c) => {
			const ctx = c.req.valid('json') satisfies ListCtx;
			const found = lookup(ctx.workspace);
			if (!found.ok) {
				return c.json(
					Err(found.error) satisfies Result<ListResult, SerializedError>,
				);
			}
			// Domain errors must arrive as HTTP 200 with serialized Result;
			// HandlerCrashed (HTTP 500) is reserved for unexpected exceptions.
			try {
				const data: ListResult = await executeList(found.entry, ctx);
				return c.json(Ok(data) satisfies Result<ListResult, SerializedError>);
			} catch (cause) {
				return c.json(
					Err(errFrom(cause)) satisfies Result<ListResult, SerializedError>,
				);
			}
		})
		.post('/run', sValidator('json', runCtxSchema), async (c) => {
			const ctx = c.req.valid('json') satisfies RunCtx;
			const found = lookup(ctx.workspaceArg);
			if (!found.ok) {
				return c.json(
					Err(found.error) satisfies Result<RunResult, SerializedError>,
				);
			}
			// Domain errors must arrive as HTTP 200 with serialized Result;
			// HandlerCrashed (HTTP 500) is reserved for unexpected exceptions.
			try {
				const data: RunResult = await executeRun(found.entry, ctx);
				return c.json(Ok(data) satisfies Result<RunResult, SerializedError>);
			} catch (cause) {
				return c.json(
					Err(errFrom(cause)) satisfies Result<RunResult, SerializedError>,
				);
			}
		})
		.post('/shutdown', (c) => {
			// Defer past the current event-loop turn so the response is flushed
			// to the kernel before `server.stop()` closes the listening socket.
			setTimeout(triggerShutdown, 0);
			return c.json(Ok(null) satisfies Result<null, never>);
		});
}

/**
 * Static type of the daemon's Hono app. Imported by `client.ts` so
 * `hc<DaemonApp>` infers each route's input/output without us redeclaring
 * the contracts.
 */
export type DaemonApp = ReturnType<typeof buildApp>;
