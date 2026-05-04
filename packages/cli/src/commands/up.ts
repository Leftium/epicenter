/**
 * `epicenter up`: start the long-lived foreground daemon for one project.
 *
 * Loads every daemon route declared by `epicenter.config.ts` and exposes a
 * Unix-socket IPC channel for that project. `peers`, `list`, and `run`
 * dispatch to this daemon over IPC; without `up` they error with a hint
 * pointing back here.
 *
 * One daemon per project; that daemon serves every route in the config.
 * Resource isolation between routes is expressed by splitting them into
 * different config dirs, not by a flag.
 *
 * Foreground by design; backgrounding is the user's job (see Invariant 5
 * in the design spec).
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Process lifecycle",
 * § "Logging", § "Invariants".
 */

import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	createDaemonServer,
	type DaemonMetadata,
	type StartupError,
	socketPathFor,
	type UnixSocketServer,
	unlinkMetadata,
	writeMetadata,
} from '@epicenter/workspace/node';
import { Ok, type Result } from 'wellcrafted/result';
/**
 * Read once at module load. Bun resolves the JSON import relative to this
 * file at build/run time, so no runtime fs work happens per `up` invocation.
 */
import packageJson from '../../package.json' with { type: 'json' };
import {
	CONFIG_FILENAME,
	DaemonConfigError,
	disposeStartedDaemonRoutes,
	type LoadedDaemonConfig,
	loadDaemonConfig,
	type StartedDaemonRoute,
	startDaemonRoutes,
} from '../load-config.js';
import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';

const CLI_VERSION = packageJson.version;

/**
 * Sync-status / awareness lines write directly to stderr so they reach the
 * operator regardless of `--quiet`; the brief calls these out as "print
 * regardless of --quiet". `--quiet` only suppresses awareness join/leave
 * lines (handled at their call sites), not these.
 */
function logSyncStatus(message: string): void {
	process.stderr.write(`${message}\n`);
}

export type UpOptions = {
	projectDir: string;
	quiet: boolean;
	cliVersion?: string;
};

/**
 * Handle returned by {@link runUp}. The daemon body is exposed as a
 * standalone async function (no `process.exit`) so unit tests can drive
 * startup, exercise the IPC handler in-process, and call `teardown()` to
 * release resources without spawning a child.
 *
 * - `server` is the bound `net.Server` (handler dispatches IPC frames).
 * - `runtimes` is every hosted daemon runtime the config declares; the daemon
 *   serves them all and routes IPC requests by route.
 * - `metadata` is what was written to disk.
 * - `teardown()` closes the server, asyncDisposes the config, and unlinks
 *   metadata + socket. Idempotent.
 */
export type UpHandle = {
	server: UnixSocketServer;
	runtimes: StartedDaemonRoute[];
	config: LoadedDaemonConfig;
	metadata: DaemonMetadata;
	socketPath: string;
	teardown: () => Promise<void>;
};

/**
 * Surface for swapping out config/server construction in tests. The yargs
 * handler passes the production defaults; `up.test.ts` passes fakes.
 */
export type RunUpDeps = {
	loadDaemonConfig?: (
		dir: string,
	) => Promise<Result<LoadedDaemonConfig, DaemonConfigError>>;
	startDaemonRoutes?: (
		config: LoadedDaemonConfig,
	) => Promise<Result<StartedDaemonRoute[], DaemonConfigError>>;
};

/**
 * Daemon body. Idempotently sets up disk state, loads every hosted daemon runtime,
 * binds the IPC socket, and returns a handle. The
 * yargs `handler` calls this, prints the operator-facing banner, installs
 * SIGINT/SIGTERM, and parks the process; tests call it directly and
 * assert on the returned handle.
 *
 * Host factories perform local setup before resolving. Network sync connects
 * in the background after the socket is bound.
 */
export async function runUp(
	options: UpOptions,
	deps: RunUpDeps = {},
): Promise<Result<UpHandle, DaemonConfigError | StartupError>> {
	const projectDir = resolve(options.projectDir);
	const socketPath = socketPathFor(projectDir);
	const configPath = join(projectDir, CONFIG_FILENAME);

	if (!(await Bun.file(configPath).exists())) {
		return DaemonConfigError.MissingFile({ configPath });
	}

	let teardown: () => Promise<void> = async () => {};

	// Bind before writing our metadata. On AlreadyRunning the live
	// daemon's sidecar must stay intact; on a stale-socket recovery
	// `bindOrRecover` unlinks the orphan metadata internally before our
	// successful retry, so the writeMetadata below records *our* pid.
	const daemonServer = createDaemonServer({
		projectDir,
		triggerShutdown: () => void teardown(),
	});
	const bindResult = await daemonServer.listen();
	if (bindResult.error) return bindResult;
	const server = bindResult.data;

	const configMtime = readConfigMtime(projectDir);
	const metadata: DaemonMetadata = {
		pid: process.pid,
		dir: projectDir,
		startedAt: new Date().toISOString(),
		cliVersion: options.cliVersion ?? CLI_VERSION,
		configMtime,
	};
	writeMetadata(projectDir, metadata);

	const loader = deps.loadDaemonConfig ?? loadDaemonConfig;
	const starter = deps.startDaemonRoutes ?? startDaemonRoutes;
	const loadResult = await loader(projectDir);
	if (loadResult.error) {
		await daemonServer.close();
		unlinkMetadata(projectDir);
		return loadResult;
	}
	const config = loadResult.data;

	const startResult = await starter(config);
	if (startResult.error) {
		await daemonServer.close();
		unlinkMetadata(projectDir);
		return startResult;
	}
	const runtimes = startResult.data;

	try {
		daemonServer.mountRoutes(runtimes);
	} catch (cause) {
		await safeDisposeStartedRoutes(runtimes);
		await daemonServer.close();
		unlinkMetadata(projectDir);
		throw cause;
	}

	let teardownPromise: Promise<void> | null = null;
	teardown = (): Promise<void> => {
		if (teardownPromise) return teardownPromise;
		teardownPromise = (async () => {
			await daemonServer.close();
			await safeDisposeStartedRoutes(runtimes);
			unlinkMetadata(projectDir);
		})();
		return teardownPromise;
	};

	return Ok({
		server,
		runtimes,
		config,
		metadata,
		socketPath,
		teardown,
	});
}

/**
 * Yargs `up` command. Thin glue: parses argv, calls {@link runUp}, prints
 * the operator-facing banner + initial peers snapshot, wires SIGINT/SIGTERM,
 * subscribes to awareness/status across every loaded workspace, and parks
 * until a signal triggers teardown.
 */
export const upCommand = cmd({
	command: 'up',
	describe:
		'Bring this config online as a long-lived peer for every hosted daemon route (foreground).',
	builder: {
		C: projectOption,
		quiet: {
			type: 'boolean',
			default: false,
			description:
				'Suppress awareness join/leave lines (sync state changes still print)',
		},
	},
	handler: async (argv) => {
		const options: UpOptions = {
			projectDir: argv.C,
			quiet: argv.quiet,
		};

		const { data: handle, error } = await runUp(options);
		if (error) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}

		const routes = handle.runtimes.map((entry) => entry.route).join(', ');
		logSyncStatus(`online (routes=[${routes}])`);

		for (const entry of handle.runtimes) {
			printPeersSnapshot(entry);
			subscribeAwareness(entry, options.quiet);
			subscribeSyncStatus(entry);
		}

		const onSignal = () => {
			void handle.teardown().then(
				() => process.exit(0),
				() => process.exit(1),
			);
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);

		// Park: don't exit. SIGINT/SIGTERM handler clears stdin so node can drain.
		process.stdin.resume();
	},
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readConfigMtime(absDir: string): number {
	const p = join(absDir, CONFIG_FILENAME);
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

async function safeDisposeStartedRoutes(
	runtimes: readonly StartedDaemonRoute[],
): Promise<void> {
	try {
		await disposeStartedDaemonRoutes(runtimes);
	} catch {
		// Best-effort cleanup; the daemon is exiting anyway.
	}
}

function printPeersSnapshot(entry: StartedDaemonRoute): void {
	const peers = entry.runtime.awareness.peers();
	if (peers.size === 0) {
		process.stderr.write(`${entry.route}: no peers connected\n`);
		return;
	}
	for (const [clientID, state] of peers) {
		process.stderr.write(
			`${entry.route}: peer ${state.peer.id} (clientID=${clientID}, name=${state.peer.name})\n`,
		);
	}
}

function subscribeAwareness(entry: StartedDaemonRoute, quiet: boolean): void {
	const awareness = entry.runtime.awareness;
	let prev = new Map(awareness.peers());
	awareness.observe(() => {
		const next = awareness.peers();
		for (const [clientID, state] of next) {
			if (!prev.has(clientID)) {
				if (!quiet) {
					process.stderr.write(
						`${entry.route}: ${state.peer.id} joined (clientID=${clientID})\n`,
					);
				}
			}
		}
		for (const [clientID, state] of prev) {
			if (!next.has(clientID)) {
				if (!quiet) {
					process.stderr.write(
						`${entry.route}: ${state.peer.id} left (clientID=${clientID})\n`,
					);
				}
			}
		}
		prev = new Map(next);
	});
}

function subscribeSyncStatus(entry: StartedDaemonRoute): void {
	const sync = entry.runtime.sync;
	sync.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`${entry.route}: connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus(`${entry.route}: connected`);
		} else if (status.phase === 'offline') {
			logSyncStatus(`${entry.route}: offline`);
		}
	});
}
