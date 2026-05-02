/**
 * Daemon server factory: build the Hono app for started routes and bind a
 * unix socket. The "build + bind" core extracted from the CLI's
 * `epicenter up` command so any bun process (CLI, vault, embedded) can
 * stand up the daemon transport without depending on `@epicenter/cli`.
 *
 * Lifecycle (metadata sidecar, signal handlers, log routing, dispose
 * orchestration) stays with the caller. This factory owns only the two
 * pieces that have to live in the workspace package: daemon route dispatch
 * and the unix-socket listener.
 *
 * See spec: `20260429T004302-workspace-as-daemon-transport.md` § Phase 2.
 */

import { Ok, type Result } from 'wellcrafted/result';

import { buildDaemonApp } from './app.js';
import { pingDaemon } from './client.js';
import { socketPathFor } from './paths.js';
import { validateDaemonRouteNames } from './route-validation.js';
import type { StartedDaemonRoute } from './types.js';
import {
	bindOrRecover,
	type StartupError,
	unlinkSocketFile,
} from './unix-socket.js';

export type DaemonServerOptions = {
	/** Filesystem-resolved absolute path that scopes this daemon. */
	projectDir: string;
	/** Started daemon routes served by the unix-socket app. */
	routes: readonly StartedDaemonRoute[];
	/** Called by the optional `/shutdown` route after the response is queued. */
	triggerShutdown?: () => void;
};

export type DaemonServer = {
	/** Filesystem path of the unix socket this server binds. */
	readonly socketPath: string;
	/**
	 * Bind the unix socket. On a stale socket left by a crashed predecessor
	 * the bind sweeps the orphan and retries; on a live daemon answering
	 * ping at the same path it returns `StartupError.AlreadyRunning`. Calls
	 * after a successful `listen()` are a no-op until `close()` runs.
	 */
	listen(): Promise<Result<void, StartupError>>;
	/**
	 * Stop the bound listener. `Bun.serve.stop()` unlinks the socket file
	 * itself; this method also sweeps any leftover socket file as a guard
	 * for hard-error paths. Idempotent.
	 */
	close(): Promise<void>;
};

/**
 * Build a daemon route table from already-started `routes`, return a handle
 * with a deferred `listen()`. The factory does not touch the filesystem
 * until `listen()` is called.
 */
export function createDaemonServer({
	projectDir,
	routes,
	triggerShutdown,
}: DaemonServerOptions): DaemonServer {
	const socketPath = socketPathFor(projectDir);
	const routeIssue = validateDaemonRouteNames(
		routes.map((entry) => entry.route),
	);
	if (routeIssue !== null) {
		throw new Error(
			routeIssue.reason === 'duplicate'
				? `createDaemonServer: duplicate daemon route '${routeIssue.route}'`
				: `createDaemonServer: invalid daemon route '${routeIssue.route}'`,
		);
	}
	const fetch = buildDaemonApp([...routes], triggerShutdown).fetch;

	let server: Bun.Server<undefined> | undefined;

	return {
		socketPath,
		async listen() {
			if (server !== undefined) return Ok(undefined);
			const result = await bindOrRecover({
				socketPath,
				fetch,
				projectDir,
				isSocketResponsive: pingDaemon,
			});
			if (result.error === null) server = result.data;
			return result.error === null ? Ok(undefined) : result;
		},
		async close() {
			if (server) {
				void server.stop(true).catch(() => {
					// best-effort
				});
				server = undefined;
			}
			unlinkSocketFile(socketPath);
		},
	};
}
