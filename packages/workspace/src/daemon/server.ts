/**
 * Daemon server factory: build the route table, build the Hono app, and
 * bind a unix socket. The "build + bind" core extracted from the CLI's
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

import type { Result } from 'wellcrafted/result';

import { buildDaemonApp } from './app.js';
import { pingDaemon } from './client.js';
import { socketPathFor } from './paths.js';
import type { DaemonRuntimeEntry } from './types.js';
import {
	bindOrRecover,
	type StartupError,
	type UnixSocketServer,
	unlinkSocketFile,
} from './unix-socket.js';

export type DaemonServerOptions = {
	/** Filesystem-resolved absolute path that scopes this daemon. */
	projectDir: string;
	/**
	 * Pre-constructed daemon runtimes the daemon serves. Each entry's
	 * `route` is the routing key the wire surface dispatches on. The CLI uses
	 * this as the first segment in route-prefixed action paths.
	 */
	entries: DaemonRuntimeEntry[];
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
	listen(): Promise<Result<UnixSocketServer, StartupError>>;
	/**
	 * Stop the bound listener. `Bun.serve.stop()` unlinks the socket file
	 * itself; this method also sweeps any leftover socket file as a guard
	 * for hard-error paths. Idempotent.
	 */
	close(): Promise<void>;
};

/**
 * Build a daemon route table from `opts.entries`, return a handle
 * with a deferred `listen()`. The factory does not touch the filesystem
 * until `listen()` is called.
 */
export function createDaemonServer({
	projectDir,
	entries,
	triggerShutdown,
}: DaemonServerOptions): DaemonServer {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.route)) {
			throw new Error(
				`createDaemonServer: duplicate daemon route '${entry.route}'`,
			);
		}
		seen.add(entry.route);
	}

	const socketPath = socketPathFor(projectDir);
	const app = buildDaemonApp(entries, triggerShutdown);

	let server: UnixSocketServer | undefined;

	return {
		socketPath,
		async listen() {
			const result = await bindOrRecover(
				socketPath,
				projectDir,
				app,
				pingDaemon,
			);
			if (result.error === null) server = result.data;
			return result;
		},
		async close() {
			if (server) {
				try {
					server.stop();
				} catch {
					// best-effort
				}
				server = undefined;
			}
			unlinkSocketFile(socketPath);
		},
	};
}
