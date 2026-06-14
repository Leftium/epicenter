/**
 * `epicenter daemon up`: start the long-lived foreground daemon for one Epicenter root.
 *
 * Loads the mount declared in `epicenter.config.ts`, opens it, and exposes a
 * Unix-socket IPC channel for that root. `peers`, `list`, and `run` dispatch to
 * this daemon over IPC; without `daemon up` they error with a hint pointing
 * back here.
 *
 * One daemon per Epicenter root; one folder declares one mount. Resource
 * isolation between apps is expressed by separate folders, each its own root.
 *
 * Foreground by design; backgrounding is the user's job.
 */

import { realpathSync } from 'node:fs';
import type { SyncAuthClient } from '@epicenter/auth';
import {
	createMachineAuthClient,
	type MachineAuthStorageError,
} from '@epicenter/auth/node';
import type { StartedMount } from '@epicenter/workspace/daemon';
import {
	claimDaemonLease,
	type DaemonMetadata,
	type EpicenterConfigError,
	type InactiveMount,
	openEpicenterRoot,
	StartupError,
	startDaemonServer,
	unlinkMetadata,
	type WorkspaceAppError,
	writeMetadata,
} from '@epicenter/workspace/node';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import packageJson from '../../package.json' with { type: 'json' };
import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';

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
	 * The Epicenter root (the app folder that holds `epicenter.config.ts`). The
	 * yargs `-C` option
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
 * - `mounts` is the started mount runtime (zero or one); the daemon serves it
 *   and routes IPC requests by mount name.
 * - `inactive` is the mount if it returned `inactive(reason)` instead of a
 *   runtime (typically a signed-out, keyring-backed mount). It is not served.
 * - `metadata` is what was written to disk.
 * - `teardown()` closes the server, asyncDisposes the runtimes, releases the
 *   lease, and unlinks metadata + socket. Idempotent.
 */
type UpHandle = {
	mounts: StartedMount[];
	inactive: InactiveMount[];
	metadata: DaemonMetadata;
	teardown: () => Promise<void>;
};

/**
 * Daemon body. Opens the configured mount (the root must already have an
 * `epicenter.config.ts`; see `epicenter init`), binds the IPC socket, and
 * returns a handle. The yargs `handler` calls this,
 * prints the operator-facing banner, installs SIGINT/SIGTERM, and parks the
 * process; tests call it directly and assert on the returned handle.
 *
 * A SQLite daemon lease serializes startup before the mount opens. After that,
 * `openEpicenterRoot` imports `epicenter.config.ts`, claims the Epicenter
 * folder, opens the mount, and `startDaemonServer` binds the socket.
 */
export async function runUp(
	options: UpOptions,
): Promise<
	Result<
		UpHandle,
		| EpicenterConfigError
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

	// Load the machine auth client up front. A signed-out machine ("no saved
	// session") is a valid state: the daemon still serves local mounts and
	// reports session-only mounts as inactive, so it maps to a `null` session.
	// Any other storage error is fatal.
	const createAuthClient = options.createAuthClient ?? createMachineAuthClient;
	const authResult = await createAuthClient();
	let auth: SyncAuthClient | null = null;
	if (authResult.error) {
		if (authResult.error.name !== 'NoSavedSession')
			return Err(authResult.error);
	} else {
		const client = authResult.data;
		auth = client;
		stack.defer(() => client[Symbol.dispose]());
	}

	const startResult = await openEpicenterRoot({ epicenterRoot, auth });
	if (startResult.error) return startResult;
	const opened = startResult.data;
	const mounts = opened.status === 'started' ? [opened.entry] : [];
	const inactive = opened.status === 'inactive' ? [opened.entry] : [];
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
		inactive,
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
		'Open the mount in epicenter.config.ts and serve it on the daemon socket (foreground).',
	builder: {
		C: epicenterRootOption,
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
		for (const declined of handle.inactive) {
			logSyncStatus(`${declined.mount}: inactive (${declined.reason})`);
		}

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

function printPeersSnapshot(entry: StartedMount): void {
	const collaboration = entry.runtime.collaboration;
	if (!collaboration) return;
	const devices = collaboration.devices.list();
	if (devices.length === 0) {
		process.stderr.write(`${entry.mount}: no peers connected\n`);
		return;
	}
	for (const device of devices) {
		process.stderr.write(`${entry.mount}: peer ${device.deviceId}\n`);
	}
}

function subscribePeers(entry: StartedMount, quiet: boolean): void {
	const collaboration = entry.runtime.collaboration;
	if (!collaboration) return;
	const snapshot = () =>
		new Set(collaboration.devices.list().map((device) => device.deviceId));
	let prev = snapshot();
	collaboration.devices.subscribe(() => {
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
	const collaboration = entry.runtime.collaboration;
	if (!collaboration) return;
	collaboration.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`${entry.mount}: connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus(`${entry.mount}: connected`);
		} else if (status.phase === 'offline') {
			logSyncStatus(`${entry.mount}: offline`);
		}
	});
}
