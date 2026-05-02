/**
 * Daemon server starter: build the app for started routes and bind a unix
 * socket. The "build + bind" core extracted from the CLI's
 * `epicenter up` command so any bun process (CLI, vault, embedded) can
 * stand up the daemon transport without depending on `@epicenter/cli`.
 *
 * Lifecycle (metadata sidecar, signal handlers, log routing, dispose
 * orchestration) stays with the caller. This starter owns only the two
 * pieces that have to live in the workspace package: daemon route dispatch
 * and the unix-socket listener.
 *
 * See spec: `20260429T004302-workspace-as-daemon-transport.md` § Phase 2.
 */

import { Ok, type Result } from 'wellcrafted/result';

import { buildDaemonApp } from './app.js';
import { bestEffortAsync } from './best-effort.js';
import { pingDaemon } from './client.js';
import type { DaemonLease } from './lease.js';
import { validateDaemonRouteNames } from './route-validation.js';
import { unlinkSocketFile } from './runtime-files.js';
import {
	StartupError,
	type StartupError as StartupErrorType,
} from './startup-errors.js';
import type { StartedDaemonRoute } from './types.js';
import { bindOrRecover } from './unix-socket.js';

export type DaemonServerOptions = {
	/** Already-claimed project daemon lease. */
	lease: DaemonLease;
	/** Started daemon routes served by the unix-socket app. */
	routes: readonly StartedDaemonRoute[];
	/** Called by the optional `/shutdown` route after the response is queued. */
	triggerShutdown?: () => void;
};

export type DaemonServer = {
	/** Filesystem path of the unix socket this server binds. */
	readonly socketPath: string;
	/**
	 * Stop the bound listener. `Bun.serve.stop()` unlinks the socket file
	 * itself; this method also sweeps any leftover socket file as a guard
	 * for hard-error paths. Idempotent.
	 */
	close(): Promise<void>;
};

/**
 * Start a daemon server for already-started routes. The caller must claim the
 * daemon lease before route startup; this function owns only route validation
 * and socket binding.
 */
export async function startDaemonServer({
	lease,
	routes,
	triggerShutdown,
}: DaemonServerOptions): Promise<Result<DaemonServer, StartupErrorType>> {
	const { projectDir, socketPath } = lease;
	const routeIssue = validateDaemonRouteNames(
		routes.map((entry) => entry.route),
	);
	if (routeIssue !== null) {
		return routeIssue.reason === 'duplicate'
			? StartupError.DuplicateRoute({ route: routeIssue.route })
			: StartupError.InvalidRoute({ route: routeIssue.route });
	}

	const app = buildDaemonApp([...routes], triggerShutdown);
	const result = await bindOrRecover({
		socketPath,
		fetch: app.fetch,
		projectDir,
		isSocketResponsive: pingDaemon,
	});
	if (result.error !== null) return result;

	const server = result.data;
	let isClosed = false;

	return Ok({
		socketPath,
		async close() {
			if (isClosed) return;
			isClosed = true;
			await bestEffortAsync(() => server.stop(true));
			unlinkSocketFile(socketPath);
		},
	});
}
