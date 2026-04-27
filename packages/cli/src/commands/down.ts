/**
 * `epicenter down` — stop a running `up` daemon.
 *
 * Default: shut down the daemon for `--dir` via IPC `shutdown` (1 s budget).
 * If the daemon doesn't reply in time (hung handler, unresponsive socket),
 * fall back to `SIGTERM` against the recorded pid. `--all` enumerates every
 * daemon for the current user and shuts them down in parallel.
 *
 * No confirmation prompt — daemons are kill-friendly by design.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Process lifecycle".
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Argv, CommandModule } from 'yargs';

import { ipcCall, type IpcCallResult } from '../daemon/ipc-client.js';
import {
	type DaemonMetadata,
	isProcessAlive,
	readMetadata,
	unlinkMetadata,
} from '../daemon/metadata.js';
import { runtimeDir, socketPathFor } from '../daemon/paths.js';
import { dirFromArgv, dirOption } from '../util/common-options.js';

const SHUTDOWN_TIMEOUT_MS = 1000;

export type DownOptions = {
	dir: string;
	all: boolean;
};

/**
 * Test seam for `runDown`. Both fields default to the production
 * implementations; tests can stub `ipcCall` to simulate a hung daemon and
 * `kill` to capture the SIGTERM fallback without actually signaling pids.
 */
export type RunDownDeps = {
	/**
	 * Non-generic mirror of `ipcCall`. `down` only checks `ok`, never reads
	 * `data`, so a `void` return is sufficient — and avoids the generic
	 * inference noise that comes with reusing `typeof ipcCall` in tests.
	 */
	ipcCall?: (
		socketPath: string,
		cmd: string,
		args?: unknown,
		options?: { timeoutMs?: number },
	) => Promise<IpcCallResult<void>>;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
};

/** Outcome of stopping a single daemon. */
export type DownOutcome =
	| { kind: 'graceful'; pid: number; dir: string }
	| { kind: 'sigterm'; pid: number; dir: string }
	| { kind: 'absent'; dir: string };

/**
 * Result returned by {@link runDown}. The CLI handler renders this; tests
 * assert on the shape directly.
 */
export type DownResult = {
	outcomes: DownOutcome[];
};

/**
 * Stop a single daemon by metadata. Tries IPC `shutdown` first; falls back
 * to `SIGTERM` after {@link SHUTDOWN_TIMEOUT_MS} ms or on any non-ok reply.
 *
 * Returns `'graceful'` when the daemon acknowledged the shutdown, `'sigterm'`
 * when we had to fall through, and (only the caller decides) `'absent'`
 * when there was no metadata to begin with.
 */
async function shutdownOne(
	meta: DaemonMetadata,
	deps: Required<RunDownDeps>,
): Promise<DownOutcome> {
	const sock = socketPathFor(meta.dir);
	const reply: IpcCallResult = await deps.ipcCall(sock, 'shutdown', undefined, {
		timeoutMs: SHUTDOWN_TIMEOUT_MS,
	});

	if (reply.ok) {
		return { kind: 'graceful', pid: meta.pid, dir: meta.dir };
	}

	// IPC didn't ack — fall back to SIGTERM if the pid is alive.
	if (isProcessAlive(meta.pid)) {
		try {
			deps.kill(meta.pid, 'SIGTERM');
		} catch {
			// pid raced to exit between the alive check and the kill —
			// equivalent to graceful from our perspective.
		}
	}
	// Best-effort sweep — graceful shutdown would have removed these.
	unlinkMetadata(meta.dir);
	return { kind: 'sigterm', pid: meta.pid, dir: meta.dir };
}

/**
 * Daemon-stop body. Pure function over disk + IPC; the yargs handler wraps
 * this with stderr formatting and `process.exit`. Tests inject `ipcCall`
 * and `kill` to stay unit-level.
 *
 * Behavior:
 *   - `--all`: enumerate `<runtimeDir>/*.meta.json`, shut each down in
 *     parallel.
 *   - default: shut down the daemon for `--dir`, or report `'absent'` if
 *     no metadata exists.
 */
export async function runDown(
	options: DownOptions,
	deps: RunDownDeps = {},
): Promise<DownResult> {
	const resolved: Required<RunDownDeps> = {
		ipcCall: deps.ipcCall ?? ipcCall,
		kill: deps.kill ?? ((pid, sig) => process.kill(pid, sig)),
	};

	if (options.all) {
		const root = runtimeDir();
		const entries = existsSync(root) ? readdirSync(root) : [];
		const metas = entries
			.filter((name) => name.endsWith('.meta.json'))
			.map((name) => readMetadataFromFile(`${root}/${name}`))
			.filter((m): m is DaemonMetadata => m !== null);

		const outcomes = await Promise.all(
			metas.map((m) => shutdownOne(m, resolved)),
		);
		return { outcomes };
	}

	const absDir = resolve(options.dir);
	const meta = readMetadata(absDir);
	if (!meta) {
		return { outcomes: [{ kind: 'absent', dir: absDir }] };
	}
	const outcome = await shutdownOne(meta, resolved);
	return { outcomes: [outcome] };
}

/**
 * Helper: read metadata by absolute path (the `--all` enumeration knows the
 * filename, not the workspace dir). Returns `null` on any read/parse error.
 */
function readMetadataFromFile(path: string): DaemonMetadata | null {
	try {
		const raw = readFileSync(path, 'utf8');
		return JSON.parse(raw) as DaemonMetadata;
	} catch {
		return null;
	}
}

export const downCommand: CommandModule = {
	command: 'down',
	describe: 'Stop a running `epicenter up` daemon.',
	builder: (yargs: Argv) =>
		yargs
			.option('dir', dirOption)
			.option('all', {
				type: 'boolean',
				default: false,
				description: 'Stop every running daemon for this user.',
			}),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const options: DownOptions = {
			dir: dirFromArgv(args),
			all: args.all === true,
		};

		const result = await runDown(options);

		if (options.all) {
			const stopped = result.outcomes.filter((o) => o.kind !== 'absent').length;
			process.stdout.write(`stopped ${stopped} daemon${stopped === 1 ? '' : 's'}\n`);
			return;
		}

		const [outcome] = result.outcomes;
		if (!outcome || outcome.kind === 'absent') {
			process.stderr.write(`no daemon running for ${outcome?.dir ?? options.dir}\n`);
			return;
		}
		if (outcome.kind === 'graceful') {
			process.stdout.write(`stopped (pid=${outcome.pid})\n`);
		} else {
			process.stderr.write(
				`shutdown timed out — sent SIGTERM (pid=${outcome.pid})\n`,
			);
		}
	},
};
