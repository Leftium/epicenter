/**
 * `epicenter daemon up`: start the long-lived foreground daemon for one project.
 *
 * Discovers every daemon extension under `<projectDir>/workspaces/*`, opens
 * each one in parallel, and exposes a Unix-socket IPC channel for that
 * project. `peers`, `list`, and `run` dispatch to this daemon over IPC;
 * without `daemon up` they error with a hint pointing back here.
 *
 * One daemon per project; that daemon serves every folder-routed extension.
 * Resource isolation between extensions is expressed by splitting them into
 * different projects, not by a flag.
 *
 * Foreground by design; backgrounding is the user's job (see Invariant 5
 * in the design spec).
 *
 * See `specs/20260516T180000-folder-routed-daemon-extensions.md`.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMachineAuthClient } from '@epicenter/auth/node';
import type { StartedDaemonRoute } from '@epicenter/workspace/daemon';
import {
	claimDaemonLease,
	type DaemonMetadata,
	type DaemonServer,
	StartupError,
	type StartupError as StartupErrorType,
	startDaemonServer,
	startDaemonWorkspaceApps,
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
 * - `runtimes` is every daemon extension runtime the project declares; the
 *   daemon serves them all and routes IPC requests by route.
 * - `metadata` is what was written to disk.
 * - `teardown()` closes the server, asyncDisposes the runtimes, releases the
 *   lease, and unlinks metadata + socket. Idempotent.
 */
export type UpHandle = {
	runtimes: StartedDaemonRoute[];
	metadata: DaemonMetadata;
	socketPath: string;
	teardown: () => Promise<void>;
};

/**
 * Daemon body. Idempotently sets up disk state, opens every discovered daemon
 * extension, binds the IPC socket, and returns a handle. The yargs `handler`
 * calls this, prints the operator-facing banner, installs SIGINT/SIGTERM,
 * and parks the process; tests call it directly and assert on the returned
 * handle.
 *
 * A SQLite daemon lease claims ownership before any extension import. After
 * that, `startDaemonWorkspaceApps` opens every folder-routed extension and
 * `startDaemonServer` binds the socket.
 */
export async function runUp(
	options: UpOptions,
): Promise<Result<UpHandle, WorkspaceAppError | StartupErrorType>> {
	const projectDir = realpathSync(resolve(options.projectDir));
	const leaseResult = claimDaemonLease(projectDir);
	if (leaseResult.error !== null) return leaseResult;
	const lease = leaseResult.data;

	const metadata: DaemonMetadata = {
		pid: process.pid,
		dir: projectDir,
		startedAt: new Date().toISOString(),
		cliVersion: options.cliVersion ?? CLI_VERSION,
		discoveredAt: new Date().toISOString(),
	};

	let metadataWritten = false;
	let runtimes: StartedDaemonRoute[] = [];
	let daemonServer: DaemonServer | null = null;
	let auth: Awaited<ReturnType<typeof createMachineAuthClient>> | null = null;
	let teardownPromise: Promise<void> | null = null;
	const teardown = (): Promise<void> => {
		if (teardownPromise) return teardownPromise;
		teardownPromise = (async () => {
			let closeError: unknown;
			try {
				if (daemonServer) await daemonServer.close();
			} catch (cause) {
				closeError = cause;
			}
			await safeDisposeStartedRoutes(runtimes);
			if (auth) auth[Symbol.dispose]();
			if (metadataWritten) unlinkMetadata(projectDir);
			lease.release();
			if (closeError) throw closeError;
		})();
		return teardownPromise;
	};

	auth = await createMachineAuthClient();
	const startResult = await startDaemonWorkspaceApps({
		projectDir,
		auth,
	});
	if (startResult.error) {
		await teardown();
		return startResult;
	}
	runtimes = startResult.data.routes;

	const serverResult = await startDaemonServer({
		lease,
		routes: runtimes,
		triggerShutdown: () => void teardown(),
	});
	if (serverResult.error) {
		await teardown();
		return serverResult;
	}
	daemonServer = serverResult.data;

	const metadataResult = trySync({
		try: () => writeMetadata(projectDir, metadata),
		catch: (cause) => StartupError.MetadataWriteFailed({ cause }),
	});
	if (metadataResult.error) {
		await teardown();
		return metadataResult;
	}
	metadataWritten = true;

	return Ok({
		runtimes,
		metadata,
		socketPath: lease.socketPath,
		teardown,
	});
}

/**
 * Yargs `daemon up` command. Thin glue: parses argv, calls {@link runUp}, prints
 * the operator-facing banner + initial peers snapshot, wires SIGINT/SIGTERM,
 * subscribes to presence/status across every loaded extension, and parks
 * until a signal triggers teardown.
 */
export const upCommand = cmd({
	command: 'up',
	describe:
		'Open every daemon extension under <projectDir>/workspaces/ and serve them on the project socket (foreground).',
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

async function safeDisposeStartedRoutes(
	runtimes: readonly StartedDaemonRoute[],
): Promise<void> {
	await Promise.allSettled(
		runtimes.map((entry) =>
			Promise.resolve(entry.runtime[Symbol.asyncDispose]()),
		),
	);
}

function printPeersSnapshot(entry: StartedDaemonRoute): void {
	const devices = entry.runtime.collaboration.devices.list();
	if (devices.length === 0) {
		process.stderr.write(`${entry.route}: no peers connected\n`);
		return;
	}
	for (const device of devices) {
		process.stderr.write(`${entry.route}: peer ${device.installationId}\n`);
	}
}

function subscribePeers(entry: StartedDaemonRoute, quiet: boolean): void {
	const snapshot = () =>
		new Set(
			entry.runtime.collaboration.devices
				.list()
				.map((device) => device.installationId),
		);
	let prev = snapshot();
	entry.runtime.collaboration.devices.subscribe(() => {
		const next = snapshot();
		for (const installationId of next) {
			if (!prev.has(installationId)) {
				if (!quiet) {
					process.stderr.write(`${entry.route}: ${installationId} joined\n`);
				}
			}
		}
		for (const installationId of prev) {
			if (!next.has(installationId)) {
				if (!quiet) {
					process.stderr.write(`${entry.route}: ${installationId} left\n`);
				}
			}
		}
		prev = next;
	});
}

function subscribeSyncStatus(entry: StartedDaemonRoute): void {
	entry.runtime.collaboration.onStatusChange((status) => {
		if (status.phase === 'connecting') {
			logSyncStatus(`${entry.route}: connecting (retry ${status.retries})`);
		} else if (status.phase === 'connected') {
			logSyncStatus(`${entry.route}: connected`);
		} else if (status.phase === 'offline') {
			logSyncStatus(`${entry.route}: offline`);
		}
	});
}
