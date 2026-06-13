/**
 * `epicenter daemon up`: start the long-lived foreground daemon for one project.
 *
 * Loads every mount declared in `epicenter.config.ts`, opens each one in
 * parallel, and exposes a Unix-socket IPC channel for that project. `peers`,
 * `list`, and `run` dispatch to this daemon over IPC; without `daemon up`
 * they error with a hint pointing back here.
 *
 * One daemon per project; that daemon serves every configured mount.
 * Resource isolation between mounts is expressed by splitting them into
 * different projects, not by a flag.
 *
 * Foreground by design; backgrounding is the user's job.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncAuthClient } from '@epicenter/auth';
import {
	createMachineAuthClient,
	type MachineAuthStorageError,
} from '@epicenter/auth/node';
import type { StartedMount } from '@epicenter/workspace/daemon';
import {
	claimDaemonLease,
	type DaemonMetadata,
	openProject,
	type ProjectConfigError,
	StartupError,
	startDaemonServer,
	unlinkMetadata,
	type WorkspaceAppError,
	writeMetadata,
} from '@epicenter/workspace/node';
import { Ok, type Result, trySync } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';

const CLI_VERSION = packageJson.version;

/**
 * Sync-status / presence lines write directly to stderr so they reach the
 * operator regardless of `--quiet`; the brief calls these out as "print
 * regardless of --quiet". `--quiet` only suppresses peer join/leave lines
 * (handled at their call sites), not these.
 */
function logSyncStatus(message: string): void {
	process.stderr.write(`${message}\n`);
}

type UpOptions = {
	/**
	 * The Epicenter root (the folder that holds `epicenter.config.ts`,
	 * whose direct children are the mount projections). The yargs `-C` option
	 * resolves discovery (walking up to the nearest `epicenter.config.ts`) before
	 * the handler runs; direct callers pass the root they already know.
	 */
	epicenterRoot: string;
	quiet: boolean;
	cliVersion?: string;
	/**
	 * Factory that constructs the daemon's auth client. Production uses the
	 * default (`createMachineAuthClient`, which reads the persisted cell from
	 * disk). Tests pass a stub or a deliberately-failing factory to exercise
	 * the auth-construction seam without seeding files or mutating env vars.
	 */
	createAuthClient?: () => Promise<
		Result<SyncAuthClient, MachineAuthStorageError>
	>;
};

/**
 * Handle returned by {@link runUp}. The daemon body is exposed as a
 * standalone async function (no `process.exit`) so unit tests can drive
 * startup, exercise the IPC handler in-process, and call `teardown()` to
 * release resources without spawning a child.
 *
 * - `mounts` is every started mount runtime the project declares; the daemon
 *   serves them all and routes IPC requests by mount name.
 * - `metadata` is what was written to disk.
 * - `teardown()` closes the server, asyncDisposes the runtimes, releases the
 *   lease, and unlinks metadata + socket. Idempotent.
 */
type UpHandle = {
	mounts: StartedMount[];
	metadata: DaemonMetadata;
	teardown: () => Promise<void>;
};

/**
 * Daemon body. Opens every configured mount (the project must already have an
 * `epicenter.config.ts`; see `epicenter init`), ensures the `.epicenter`
 * cache gitignore, binds the IPC socket, and returns a handle. The yargs
 * `handler` calls this,
 * prints the operator-facing banner, installs SIGINT/SIGTERM, and parks the
 * process; tests call it directly and assert on the returned handle.
 *
 * A SQLite daemon lease claims ownership before any mount opens. After that,
 * `openProject` imports `epicenter.config.ts` and opens every configured
 * mount, and `startDaemonServer` binds the socket.
 */
export async function runUp(
	options: UpOptions,
): Promise<
	Result<
		UpHandle,
		| ProjectConfigError
		| WorkspaceAppError
		| StartupError
		| MachineAuthStorageError
	>
> {
	const epicenterRoot = realpathSync(options.epicenterRoot);

	const leaseResult = claimDaemonLease(epicenterRoot);
	if (leaseResult.error !== null) return leaseResult;
	const lease = leaseResult.data;

	const metadata: DaemonMetadata = {
		pid: process.pid,
		dir: epicenterRoot,
		startedAt: new Date().toISOString(),
		cliVersion: options.cliVersion ?? CLI_VERSION,
		discoveredAt: new Date().toISOString(),
	};

	// Ordered unwinding for partially-completed startup. Each resource
	// registers its disposer as it is acquired; `AsyncDisposableStack` runs
	// them in reverse. On any early `return` or `throw` before `stack.move()`,
	// `await using` disposes exactly what was acquired. On success, `move()`
	// transfers the stack to the caller as the returned `teardown`.
	await using stack = new AsyncDisposableStack();
	stack.defer(() => lease.release());

	const createAuthClient = options.createAuthClient ?? createMachineAuthClient;
	const authResult = await createAuthClient();
	if (authResult.error) return authResult;
	const auth = authResult.data;
	stack.defer(() => auth[Symbol.dispose]());

	// Captured before openProject, which (via the attach primitives) creates
	// `.epicenter/`. A missing `.epicenter/` here means this run is the one
	// establishing the namespace, the same signal openProject's bootstrap guard
	// keys on. The root `.gitignore` is scaffolded only then, so a plain `up`
	// against an existing folder never silently rewrites its git boundary.
	const isFreshNamespace = !existsSync(join(epicenterRoot, '.epicenter'));

	const startResult = await openProject({ epicenterRoot, auth });
	if (startResult.error) return startResult;
	const mounts = startResult.data;
	ensureProjectGitignore(epicenterRoot, {
		writeRootGitignore: isFreshNamespace,
	});
	stack.defer(async () => {
		await Promise.allSettled(
			mounts.map((entry) => entry.runtime[Symbol.asyncDispose]()),
		);
	});

	const serverResult = await startDaemonServer({ lease, mounts });
	if (serverResult.error) return serverResult;
	const daemonServer = serverResult.data;
	stack.defer(() => daemonServer.close());

	const metadataResult = trySync({
		try: () => writeMetadata(epicenterRoot, metadata),
		catch: (cause) => StartupError.MetadataWriteFailed({ cause }),
	});
	if (metadataResult.error) return metadataResult;
	stack.defer(() => unlinkMetadata(epicenterRoot));

	const teardownStack = stack.move();
	return Ok({
		mounts,
		metadata,
		teardown: () => teardownStack.disposeAsync(),
	});
}

/**
 * Yargs `daemon up` command. Thin glue: parses argv, calls {@link runUp}, prints
 * the operator-facing banner + initial peers snapshot, wires SIGINT/SIGTERM,
 * subscribes to presence/status across every loaded mount, and parks
 * until a signal triggers teardown.
 */
export const upCommand = cmd({
	command: 'up',
	describe:
		'Open every mount in epicenter.config.ts and serve them on the daemon socket (foreground).',
	builder: {
		C: projectOption,
		quiet: {
			type: 'boolean',
			default: false,
			description:
				'Suppress peer join/leave lines (sync state changes still print)',
		},
	},
	handler: async (argv) => {
		const options: UpOptions = {
			epicenterRoot: argv.C,
			quiet: argv.quiet,
		};

		const { data: handle, error } = await runUp(options);
		if (error) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}

		const mountNames = handle.mounts.map((entry) => entry.mount).join(', ');
		logSyncStatus(`online (mounts=[${mountNames}])`);

		for (const entry of handle.mounts) {
			printPeersSnapshot(entry);
			subscribePeers(entry, options.quiet);
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

/**
 * Scaffold the Epicenter folder's git boundary so a tracked folder commits only
 * the config, never generated state.
 *
 * Two ignore files, each with one job:
 *
 *   <root>/.gitignore             `/*` ignores every direct child, then
 *                                 unignores `epicenter.config.ts` (and the
 *                                 ignore file itself). The config is the tracked
 *                                 boundary marker; the generated mount
 *                                 projections (`fuji/`, ...) and `.epicenter/`
 *                                 are derived from the Yjs log and rebuilt on
 *                                 demand, so git leaves them out. `/*` needs no
 *                                 mount-name list to keep in sync: it catches
 *                                 whatever the runtime writes. Written only when
 *                                 `writeRootGitignore` is set, which the caller
 *                                 ties to first establishing the namespace, so a
 *                                 plain `up` against a folder that is already a
 *                                 git repo never silently hides its untracked
 *                                 files behind a `/*` rule.
 *   <root>/.epicenter/.gitignore  `*` keeps machine state out of git even if a
 *                                 user later edits the root ignore to track a
 *                                 projection. Defense in depth for the one
 *                                 directory that must never be committed.
 *                                 Written every run (cheap, idempotent).
 *
 * `.epicenter/` is created at mode 0o700 (machine state, not world-readable).
 * Both files are written only when absent, so a user's own rules survive.
 *
 * Creating the Epicenter folder itself (writing `epicenter.config.ts`) is
 * `epicenter init`; `daemon up` never scaffolds a config, so it cannot
 * accidentally claim a normal repo root. On a directory without a config,
 * discovery fails first with a hint, and this function never runs.
 */
const ROOT_GITIGNORE = `# Epicenter folder. Only epicenter.config.ts is tracked; the generated mount
# projections and the machine state under .epicenter/ are derived from the Yjs
# log and rebuilt on demand, so git ignores them.
/*
!/.gitignore
!/epicenter.config.ts
`;

function ensureProjectGitignore(
	epicenterRoot: string,
	{ writeRootGitignore }: { writeRootGitignore: boolean },
): void {
	if (writeRootGitignore) {
		const rootGitignorePath = join(epicenterRoot, '.gitignore');
		if (!existsSync(rootGitignorePath)) {
			writeFileSync(rootGitignorePath, ROOT_GITIGNORE);
		}
	}

	const projectDataDir = join(epicenterRoot, '.epicenter');
	mkdirSync(projectDataDir, { recursive: true, mode: 0o700 });
	const cacheGitignorePath = join(projectDataDir, '.gitignore');
	if (!existsSync(cacheGitignorePath)) {
		writeFileSync(cacheGitignorePath, '*\n', { mode: 0o600 });
	}
}

function printPeersSnapshot(entry: StartedMount): void {
	const devices = entry.runtime.collaboration.devices.list();
	if (devices.length === 0) {
		process.stderr.write(`${entry.mount}: no peers connected\n`);
		return;
	}
	for (const device of devices) {
		process.stderr.write(`${entry.mount}: peer ${device.deviceId}\n`);
	}
}

function subscribePeers(entry: StartedMount, quiet: boolean): void {
	const snapshot = () =>
		new Set(
			entry.runtime.collaboration.devices
				.list()
				.map((device) => device.deviceId),
		);
	let prev = snapshot();
	entry.runtime.collaboration.devices.subscribe(() => {
		const next = snapshot();
		for (const deviceId of next) {
			if (!prev.has(deviceId)) {
				if (!quiet) {
					process.stderr.write(`${entry.mount}: ${deviceId} joined\n`);
				}
			}
		}
		for (const deviceId of prev) {
			if (!next.has(deviceId)) {
				if (!quiet) {
					process.stderr.write(`${entry.mount}: ${deviceId} left\n`);
				}
			}
		}
		prev = next;
	});
}

function subscribeSyncStatus(entry: StartedMount): void {
	entry.runtime.collaboration.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`${entry.mount}: connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus(`${entry.mount}: connected`);
		} else if (status.phase === 'offline') {
			logSyncStatus(`${entry.mount}: offline`);
		}
	});
}
