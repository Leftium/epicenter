/**
 * `epicenter up`: start the long-lived foreground daemon for one `--dir`.
 *
 * Loads every workspace exported by `epicenter.config.ts` and exposes a
 * Unix-socket IPC channel for that `--dir`. While `up` is running, sibling
 * commands (`peers`, `list`, `run`) **attach** to this daemon over IPC
 * instead of opening their own workspaces. Without `up`, those siblings
 * run **standalone**: each invocation opens the config itself, does its
 * work, and closes.
 *
 * One daemon per `--dir`; that daemon serves every workspace the config
 * exports (Invariant 7). Resource isolation between workspaces is
 * expressed by splitting them into different config dirs, not by a flag.
 *
 * Foreground by design; backgrounding is the user's job (see Invariant 5
 * in the design spec).
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Process lifecycle",
 * § "Logging", § "Invariants".
 */

import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
	composeSinks,
	consoleSink,
	createLogger,
	type LogEvent,
	type LogLevel,
	type LogSink,
} from 'wellcrafted/logger';
import type { Argv, CommandModule } from 'yargs';

import { buildApp } from '../daemon/app.js';
import {
	bindUnixSocket,
	type UnixSocketServer,
	unlinkSocketFile,
} from '../daemon/unix-socket.js';
import {
	type DaemonMetadata,
	inspectExistingDaemon,
	unlinkMetadata,
	writeMetadata,
} from '../daemon/metadata.js';
import { logPathFor, socketPathFor } from '../daemon/paths.js';
import {
	ROTATE_MAX_BYTES,
	rotateIfNeeded,
} from '../daemon/log-rotation.js';
import {
	CONFIG_FILENAME,
	type LoadConfigResult,
	type WorkspaceEntry,
	loadConfig,
} from '../load-config.js';
import { dirFromArgv, dirOption } from '../util/common-options.js';

/**
 * Read once at module load. Bun resolves the JSON import relative to this
 * file at build/run time, so no runtime fs work happens per `up` invocation.
 */
import packageJson from '../../package.json' with { type: 'json' };
const CLI_VERSION = packageJson.version;

const LEVEL_RANK: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};

/**
 * Build the file sink: structured JSONL, rotated at {@link ROTATE_MAX_BYTES}.
 * Synchronous `appendFileSync` keeps rotation correctness simple: the only
 * writer is this daemon, so no inter-process coordination is needed.
 *
 * One JSON object per line; native `Error` instances are normalized so
 * stack traces survive serialization.
 */
function makeRotatingJsonlSink(filePath: string): LogSink {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const normalize = (value: unknown): unknown =>
		value instanceof Error
			? { name: value.name, message: value.message, stack: value.stack }
			: value;
	const sink = (event: LogEvent) => {
		// Always at info floor (file sink ignores --quiet).
		const line = {
			ts: new Date(event.ts).toISOString(),
			level: event.level,
			source: event.source,
			message: event.message,
			...(event.data === undefined ? {} : { data: event.data }),
		};
		try {
			rotateIfNeeded(filePath, ROTATE_MAX_BYTES);
			appendFileSync(
				filePath,
				`${JSON.stringify(line, (_k, v) => normalize(v))}\n`,
				{ mode: 0o600 },
			);
		} catch {
			// File-sink failures must not crash the daemon. The stderr sink
			// remains as a fallback path for the operator.
		}
	};
	return sink as LogSink;
}

/**
 * Build a stderr sink that filters by floor level. `--quiet` raises the floor
 * to `warn`, but sync state changes write directly to `process.stderr` through
 * a non-quietable channel (see {@link logSyncStatus}).
 */
function makeStderrSink(floor: LogLevel): LogSink {
	const min = LEVEL_RANK[floor];
	const fn = (event: LogEvent) => {
		if (LEVEL_RANK[event.level] < min) return;
		consoleSink(event);
	};
	return fn as LogSink;
}

/**
 * Sync-status / awareness lines must always reach the operator (they're the
 * point of `up` in the foreground), so we route them through a non-quietable
 * stderr writer rather than the level-filtered logger. The brief calls these
 * out as "print regardless of --quiet".
 */
function logSyncStatus(message: string): void {
	process.stderr.write(`${message}\n`);
}

export type UpOptions = {
	dir: string;
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
 * - `entries` is every workspace the config exports; the daemon serves
 *   them all and routes IPC requests by name.
 * - `metadata` is what was written to disk.
 * - `teardown()` closes the server, asyncDisposes the config, and unlinks
 *   metadata + socket. Idempotent.
 */
export type UpHandle = {
	server: UnixSocketServer;
	entries: WorkspaceEntry[];
	config: LoadConfigResult;
	metadata: DaemonMetadata;
	socketPath: string;
	teardown: () => Promise<void>;
};

/**
 * Surface for swapping out config/server construction in tests. The yargs
 * handler passes the production defaults; `up.test.ts` passes fakes.
 */
export type RunUpDeps = {
	loadConfig?: (dir: string) => Promise<LoadConfigResult>;
	bindUnixSocket?: (
		socketPath: string,
		app: ReturnType<typeof buildApp>,
	) => Promise<UnixSocketServer>;
};

/**
 * Daemon body. Idempotently sets up disk state, connects every workspace
 * the config exports, binds the IPC socket, and returns a handle. The
 * yargs `handler` calls this, prints the operator-facing banner, installs
 * SIGINT/SIGTERM, and parks the process; tests call it directly and
 * assert on the returned handle.
 *
 * If any workspace fails to connect (the workspace's sync layer rejects
 * `whenConnected` with a `SyncFailedError`, e.g. on permanent auth
 * failure), the whole daemon fails. Partial-up is muddy semantics
 * ("which subset is online?") and we already have a way to express
 * "I want only this one online": split the config.
 */
export async function runUp(
	options: UpOptions,
	deps: RunUpDeps = {},
): Promise<UpHandle> {
	const absDir = resolve(options.dir);
	const socketPath = socketPathFor(absDir);
	const logPath = logPathFor(absDir);

	const stderr = makeStderrSink(options.quiet ? 'warn' : 'info');
	const fileSink = makeRotatingJsonlSink(logPath);
	const sink = composeSinks(stderr, fileSink);
	const log = createLogger('cli/up', sink);

	const inspect = await inspectExistingDaemon(absDir);
	if (inspect.state === 'in-use') {
		throw new Error(`daemon already running (pid=${inspect.pid})`);
	}
	if (inspect.state === 'orphan') {
		log.info('cleaned orphan socket', { dir: absDir, pid: inspect.pid });
	}

	const loader = deps.loadConfig ?? loadConfig;
	const config = await loader(absDir);

	if (config.entries.length === 0) {
		await safeAsyncDispose(config);
		throw new Error(
			`no workspaces exported from ${join(absDir, CONFIG_FILENAME)}`,
		);
	}

	// Wait for every workspace's "ready to accept RPC" gate concurrently.
	// One bad workspace fails the whole daemon; see runUp's docstring.
	// `whenConnected` rejects with `SyncFailedError` on permanent auth
	// failure (close code 4401), so no wallclock timer is needed here.
	try {
		await Promise.all(
			config.entries.map((entry) =>
				entry.workspace.whenReady ??
					entry.workspace.sync?.whenConnected ??
					Promise.resolve(),
			),
		);
	} catch (cause) {
		await safeAsyncDispose(config);
		throw cause;
	}

	const configMtime = readConfigMtime(absDir);
	const metadata: DaemonMetadata = {
		pid: process.pid,
		dir: absDir,
		startedAt: new Date().toISOString(),
		cliVersion: options.cliVersion ?? CLI_VERSION,
		configMtime,
	};
	writeMetadata(absDir, metadata);

	const app = buildApp(config.entries, () => void teardown());
	const starter = deps.bindUnixSocket ?? bindUnixSocket;
	let server: UnixSocketServer;
	try {
		server = await starter(socketPath, app);
	} catch (cause) {
		unlinkMetadata(absDir);
		await safeAsyncDispose(config);
		throw cause;
	}

	let teardownPromise: Promise<void> | null = null;
	const teardown = (): Promise<void> => {
		if (teardownPromise) return teardownPromise;
		teardownPromise = (async () => {
			try {
				server.stop();
			} catch {
				// best-effort
			}
			await safeAsyncDispose(config);
			unlinkMetadata(absDir);
			unlinkSocketFile(socketPath);
		})();
		return teardownPromise;
	};

	return {
		server,
		entries: config.entries,
		config,
		metadata,
		socketPath,
		teardown,
	};
}

/**
 * Yargs `up` command. Thin glue: parses argv, calls {@link runUp}, prints
 * the operator-facing banner + initial peers snapshot, wires SIGINT/SIGTERM,
 * subscribes to awareness/status across every loaded workspace, and parks
 * until a signal triggers teardown.
 */
export const upCommand: CommandModule = {
	command: 'up',
	describe:
		'Bring this config online as a long-lived peer for every workspace it exports (foreground).',
	builder: (yargs: Argv) =>
		yargs
			.option('dir', dirOption)
			.option('quiet', {
				type: 'boolean',
				default: false,
				description:
					'Suppress awareness join/leave lines (sync state changes still print)',
			}),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const options: UpOptions = {
			dir: dirFromArgv(args),
			quiet: args.quiet === true,
		};

		let handle: UpHandle;
		try {
			handle = await runUp(options);
		} catch (cause) {
			process.stderr.write(`${formatStartupError(cause)}\n`);
			process.exit(1);
		}

		const names = handle.entries.map((e) => e.name).join(', ');
		logSyncStatus(`online (workspaces=[${names}])`);

		for (const entry of handle.entries) {
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
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a startup-failure cause for stderr. Permanent auth rejections from
 * the workspace sync layer (`SyncFailedError.AuthRejected`) carry a typed
 * `code` string; surface that and point the operator at `epicenter auth
 * login`. Everything else falls back to the cause's message.
 */
function formatStartupError(cause: unknown): string {
	if (
		cause &&
		typeof cause === 'object' &&
		'name' in cause &&
		(cause as { name: unknown }).name === 'AuthRejected' &&
		'code' in cause &&
		typeof (cause as { code: unknown }).code === 'string'
	) {
		const code = (cause as { code: string }).code;
		return `auth failed: ${code}. Try \`epicenter auth login\`.`;
	}
	return cause instanceof Error ? cause.message : String(cause);
}

function readConfigMtime(absDir: string): number {
	const p = join(absDir, CONFIG_FILENAME);
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

async function safeAsyncDispose(config: LoadConfigResult): Promise<void> {
	try {
		await config[Symbol.asyncDispose]();
	} catch {
		// Best-effort cleanup; the daemon is exiting anyway.
	}
}

function printPeersSnapshot(entry: WorkspaceEntry): void {
	const peers = entry.workspace.sync?.peers();
	if (!peers || peers.size === 0) {
		process.stderr.write(`${entry.name}: no peers connected\n`);
		return;
	}
	for (const [clientID, state] of peers) {
		process.stderr.write(
			`${entry.name}: peer ${state.device.id} (clientID=${clientID}, name=${state.device.name})\n`,
		);
	}
}

function subscribeAwareness(entry: WorkspaceEntry, quiet: boolean): void {
	const sync = entry.workspace.sync;
	if (!sync) return;
	let prev = new Map(sync.peers());
	sync.observe(() => {
		const next = sync.peers();
		for (const [clientID, state] of next) {
			if (!prev.has(clientID)) {
				if (!quiet) {
					process.stderr.write(
						`${entry.name}: ${state.device.id} joined (clientID=${clientID})\n`,
					);
				}
			}
		}
		for (const [clientID, state] of prev) {
			if (!next.has(clientID)) {
				if (!quiet) {
					process.stderr.write(
						`${entry.name}: ${state.device.id} left (clientID=${clientID})\n`,
					);
				}
			}
		}
		prev = new Map(next);
	});
}

function subscribeSyncStatus(entry: WorkspaceEntry): void {
	const sync = entry.workspace.sync;
	if (!sync) return;
	sync.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`${entry.name}: connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus(`${entry.name}: connected`);
		} else if (status.phase === 'offline') {
			logSyncStatus(`${entry.name}: offline`);
		}
	});
}
