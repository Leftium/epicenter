/**
 * `epicenter up` — long-lived foreground daemon serving one `--dir`.
 *
 * Brings the workspace online as a "warm peer" and exposes a Unix-socket IPC
 * channel scoped to that `--dir`. Sibling CLI invocations (Wave 6) auto-detect
 * the socket and reuse this process's already-connected SyncAttachment instead
 * of paying a fresh handshake. Foreground by design — backgrounding is the
 * user's job (see Invariant 5 in the design spec).
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Process lifecycle",
 * § "Logging", § "Invariants".
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	statSync,
	unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Server } from 'node:net';

import {
	composeSinks,
	consoleSink,
	createLogger,
	type LogEvent,
	type LogLevel,
	type LogSink,
	type Logger,
} from 'wellcrafted/logger';
import type { Argv, CommandModule } from 'yargs';

import {
	type IpcHandler,
	type IpcRequest,
	type IpcResponse,
	startIpcServer,
} from '../daemon/ipc-server.js';
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
	type LoadConfigResult,
	type LoadedWorkspace,
	type WorkspaceEntry,
	loadConfig,
} from '../load-config.js';
import {
	dirFromArgv,
	dirOption,
	workspaceFromArgv,
	workspaceOption,
} from '../util/common-options.js';
import { resolveEntry } from '../util/resolve-entry.js';
import { listCore, type ListCtx, type ListResult } from './list.js';
import { runCore, type RunCtx, type RunResult } from './run.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const SHUTDOWN_BUDGET_MS = 2000;

const CONFIG_FILENAME = 'epicenter.config.ts';

const LEVEL_RANK: Record<LogLevel, number> = {
	trace: 0,
	debug: 1,
	info: 2,
	warn: 3,
	error: 4,
};

/**
 * Build a stderr sink that filters by floor level. Wave 7 wires the file sink
 * alongside this one; for now stderr is the only output. `--quiet` raises the
 * floor to `warn`, but sync state changes call `log.info` directly through a
 * non-quietable channel (see {@link logSyncStatus}).
 */
/**
 * Build the file sink: structured JSONL, rotated at {@link ROTATE_MAX_BYTES}.
 * Synchronous `appendFileSync` keeps rotation correctness simple — the only
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
	workspace?: string;
	quiet: boolean;
	connectTimeoutMs: number;
	cliVersion?: string;
};

/**
 * Handle returned by {@link runUp}. The daemon body is exposed as a
 * standalone async function (no `process.exit`) so unit tests can drive
 * startup, exercise the IPC handler in-process, and call `teardown()` to
 * release resources without spawning a child.
 *
 * - `server` is the bound `net.Server` (handler dispatches IPC frames).
 * - `entry` / `config` are the loaded workspace + config result.
 * - `metadata` is what was written to disk.
 * - `teardown()` closes the server, asyncDisposes the config, and unlinks
 *   metadata + socket. Idempotent.
 */
export type UpHandle = {
	server: Server;
	entry: WorkspaceEntry;
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
	startIpcServer?: (
		socketPath: string,
		handler: IpcHandler,
	) => Promise<Server>;
};

/**
 * Daemon body. Idempotently sets up disk state, connects the workspace,
 * binds the IPC socket, and returns a handle. The yargs `handler` calls
 * this, prints the operator-facing banner, installs SIGINT/SIGTERM, and
 * parks the process; tests call it directly and assert on the returned
 * handle.
 *
 * Errors are thrown (with the literal "connect failed: ..." prefix on
 * timeout) so the caller decides whether to `process.exit(1)` or surface
 * the error to a test runner.
 */
export async function runUp(
	options: UpOptions,
	deps: RunUpDeps = {},
): Promise<UpHandle> {
	const absDir = resolve(options.dir);
	const socketPath = socketPathFor(absDir);
	const logPath = logPathFor(absDir);

	// Wave 7 will use logPath for the file sink; ensuring the dir exists now
	// is a free pre-condition the file sink can rely on later.
	mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
	mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });

	const stderr = makeStderrSink(options.quiet ? 'warn' : 'info');
	// File sink: structured JSONL. Always at info-floor regardless of --quiet
	// — operators rely on the file for post-mortems. Rotate before each write
	// so the daemon stays inside the 10 MB-per-generation budget.
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

	const entry = resolveEntry(config.entries, options.workspace);

	// Race the workspace's "ready to accept RPC" gate against the connect
	// timeout. Stale-auth fast-fail acceptance criterion: the spec wording is
	// `connect failed: 401 Unauthorized — try \`epicenter auth login\`` but we
	// don't have structured auth-error data wired through `whenReady` /
	// `whenConnected` yet, so on timeout we surface what we have.
	const ready = entry.workspace.whenReady ?? entry.workspace.sync?.whenConnected;
	if (ready) {
		try {
			await raceTimeout(
				ready,
				options.connectTimeoutMs,
				() => connectFailedMessage(entry.workspace),
			);
		} catch (cause) {
			// Cleanup partial state before reflecting failure to the caller.
			await safeAsyncDispose(config);
			throw cause;
		}
	}

	const configMtime = readConfigMtime(absDir);
	const metadata: DaemonMetadata = {
		pid: process.pid,
		dir: absDir,
		workspace: entry.name,
		deviceId: pickDeviceId(entry.workspace),
		startedAt: new Date().toISOString(),
		cliVersion: options.cliVersion ?? '0.0.0',
		configMtime,
	};
	writeMetadata(absDir, metadata);

	const handler = makeHandler(entry, config, log, () => void teardown());
	const starter = deps.startIpcServer ?? startIpcServer;
	let server: Server;
	try {
		server = await starter(socketPath, handler);
	} catch (cause) {
		unlinkMetadata(absDir);
		await safeAsyncDispose(config);
		throw cause;
	}

	let teardownPromise: Promise<void> | null = null;
	const teardown = (): Promise<void> => {
		if (teardownPromise) return teardownPromise;
		teardownPromise = (async () => {
			await new Promise<void>((res) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					res();
				};
				const t = setTimeout(finish, SHUTDOWN_BUDGET_MS);
				server.close(() => {
					clearTimeout(t);
					finish();
				});
			});
			await safeAsyncDispose(config);
			unlinkMetadata(absDir);
			if (existsSync(socketPath)) {
				try {
					unlinkSync(socketPath);
				} catch {
					// Best-effort: server.close already sweeps; another process may have raced us.
				}
			}
		})();
		return teardownPromise;
	};

	return {
		server,
		entry,
		config,
		metadata,
		socketPath,
		teardown,
	};
}

/**
 * Yargs `up` command. Thin glue: parses argv, calls {@link runUp}, prints
 * the operator-facing banner + initial peers snapshot, wires SIGINT/SIGTERM,
 * subscribes to awareness/status, and parks until a signal triggers teardown.
 *
 * Tests do not call this — they exercise {@link runUp} in-process with fake
 * deps. The cross-process e2e lives in Wave 8.
 */
export const upCommand: CommandModule = {
	command: 'up',
	describe: 'Bring this workspace online as a long-lived peer (foreground).',
	builder: (yargs: Argv) =>
		yargs
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.option('quiet', {
				type: 'boolean',
				default: false,
				description:
					'Suppress awareness join/leave lines (sync state changes still print)',
			})
			.option('connect-timeout', {
				type: 'number',
				default: DEFAULT_CONNECT_TIMEOUT_MS,
				description:
					'Max ms to wait for the workspace to become ready before exiting 1',
			}),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const options: UpOptions = {
			dir: dirFromArgv(args),
			workspace: workspaceFromArgv(args),
			quiet: args.quiet === true,
			connectTimeoutMs:
				typeof args['connect-timeout'] === 'number'
					? (args['connect-timeout'] as number)
					: DEFAULT_CONNECT_TIMEOUT_MS,
		};

		let handle: UpHandle;
		try {
			handle = await runUp(options);
		} catch (cause) {
			const msg = cause instanceof Error ? cause.message : String(cause);
			process.stderr.write(`${msg}\n`);
			process.exit(1);
		}

		// Banner.
		logSyncStatus(
			`online (deviceId=${handle.metadata.deviceId}, workspace=${handle.metadata.workspace})`,
		);

		// Initial peers snapshot — print *after* "online" so the operator sees
		// current state, not just future deltas (per spec § Process lifecycle).
		printPeersSnapshot(handle.entry.workspace);

		// Awareness deltas (joined/left).
		subscribeAwareness(handle.entry.workspace, options.quiet);

		// Sync state changes (always print, even with --quiet).
		subscribeSyncStatus(handle.entry.workspace);

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
// IPC handler
// ---------------------------------------------------------------------------

/**
 * Build the per-daemon IPC dispatcher. Each `cmd` maps to a thin wrapper
 * around either workspace state (peers, status) or a graceful-shutdown
 * trigger. `list` and `run` are intentional `NotImplemented` stubs in this
 * wave — Wave 6 wires them into the refactored `listCore` / `runCore`
 * helpers.
 */
function makeHandler(
	entry: WorkspaceEntry,
	_config: LoadConfigResult,
	log: Logger,
	triggerShutdown: () => void,
): IpcHandler {
	return (req: IpcRequest, send: (r: IpcResponse) => void) => {
		log.debug('ipc cmd', { cmd: req.cmd, id: req.id });
		switch (req.cmd) {
			case 'ping':
				send({ id: req.id, ok: true, data: 'pong' });
				return;
			case 'status':
				send({
					id: req.id,
					ok: true,
					data: {
						pid: process.pid,
						workspace: entry.name,
						syncStatus: entry.workspace.sync?.status ?? null,
					},
				});
				return;
			case 'peers': {
				const peers = entry.workspace.sync?.peers() ?? new Map();
				const rows = [...peers.entries()].map(([clientID, state]) => ({
					clientID,
					device: state.device,
				}));
				send({ id: req.id, ok: true, data: rows });
				return;
			}
			case 'list': {
				const ctx = req.args as ListCtx;
				void (async () => {
					try {
						const data: ListResult = await listCore(entry, ctx);
						send({ id: req.id, ok: true, data });
					} catch (cause) {
						send({
							id: req.id,
							ok: false,
							error: {
								name: cause instanceof Error ? cause.name : 'Error',
								message:
									cause instanceof Error ? cause.message : String(cause),
							},
						});
					}
				})();
				return;
			}
			case 'run': {
				const ctx = req.args as RunCtx;
				void (async () => {
					try {
						const data: RunResult = await runCore(entry, ctx);
						send({ id: req.id, ok: true, data });
					} catch (cause) {
						send({
							id: req.id,
							ok: false,
							error: {
								name: cause instanceof Error ? cause.name : 'Error',
								message:
									cause instanceof Error ? cause.message : String(cause),
							},
						});
					}
				})();
				return;
			}
			case 'shutdown':
				send({ id: req.id, ok: true });
				triggerShutdown();
				return;
			default:
				send({
					id: req.id,
					ok: false,
					error: {
						name: 'UnknownCommand',
						message: `unknown cmd: ${req.cmd}`,
					},
				});
		}
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function raceTimeout<T>(
	promise: Promise<T>,
	ms: number,
	onTimeoutMessage: () => string,
): Promise<T> {
	return new Promise<T>((res, rej) => {
		const t = setTimeout(() => {
			rej(new Error(`connect failed: ${onTimeoutMessage()}`));
		}, ms);
		promise.then(
			(v) => {
				clearTimeout(t);
				res(v);
			},
			(cause) => {
				clearTimeout(t);
				const msg = cause instanceof Error ? cause.message : String(cause);
				rej(new Error(`connect failed: ${msg}`));
			},
		);
	});
}

/**
 * Best-effort message synthesis when `whenReady` doesn't resolve. Today's
 * SyncAttachment exposes a `status` enum (`offline`/`connecting`/`connected`)
 * with a `lastError` tag (`auth` | `connection`); we promote `auth` to the
 * spec's `401 Unauthorized` phrasing so the acceptance criterion at least
 * matches the prefix. Once the workspace surfaces structured auth errors
 * through `whenReady` / `whenConnected`, this becomes precise.
 */
function connectFailedMessage(workspace: LoadedWorkspace): string {
	const status = workspace.sync?.status;
	if (
		status &&
		status.phase === 'connecting' &&
		status.lastError?.type === 'auth'
	) {
		return '401 Unauthorized — try `epicenter auth login`';
	}
	return `timed out waiting for workspace ready`;
}

function readConfigMtime(absDir: string): number {
	const p = join(absDir, CONFIG_FILENAME);
	try {
		return statSync(p).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Read the daemon's own deviceId from awareness if available. Today's public
 * SyncAttachment doesn't expose "self" deviceId directly (it's set inside
 * `attachSync` from the `device` config arg); awareness is the only public
 * shape we can read after-the-fact, and it includes self only post-connect.
 * Falling through to `'<unknown>'` is a known gap — see report notes.
 */
function pickDeviceId(workspace: LoadedWorkspace): string {
	// The `peers()` map deliberately excludes self, so we can't read it from
	// there. Without an upstream surface change, we accept '<unknown>' here.
	void workspace;
	return '<unknown>';
}

async function safeAsyncDispose(config: LoadConfigResult): Promise<void> {
	try {
		await config[Symbol.asyncDispose]();
	} catch {
		// Best-effort cleanup; the daemon is exiting anyway.
	}
}

function printPeersSnapshot(workspace: LoadedWorkspace): void {
	const peers = workspace.sync?.peers();
	if (!peers || peers.size === 0) {
		process.stderr.write('no peers connected\n');
		return;
	}
	for (const [clientID, state] of peers) {
		process.stderr.write(
			`peer: ${state.device.id} (clientID=${clientID}, name=${state.device.name})\n`,
		);
	}
}

function subscribeAwareness(workspace: LoadedWorkspace, quiet: boolean): void {
	const sync = workspace.sync;
	if (!sync) return;
	let prev = new Map(sync.peers());
	sync.observe(() => {
		const next = sync.peers();
		// Joins
		for (const [clientID, state] of next) {
			if (!prev.has(clientID)) {
				if (!quiet) {
					process.stderr.write(
						`${state.device.id} joined (clientID=${clientID})\n`,
					);
				}
			}
		}
		// Leaves
		for (const [clientID, state] of prev) {
			if (!next.has(clientID)) {
				if (!quiet) {
					process.stderr.write(
						`${state.device.id} left (clientID=${clientID})\n`,
					);
				}
			}
		}
		prev = new Map(next);
	});
}

function subscribeSyncStatus(workspace: LoadedWorkspace): void {
	const sync = workspace.sync;
	if (!sync) return;
	sync.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus('connected');
		} else if (status.phase === 'offline') {
			logSyncStatus('offline');
		}
	});
}
