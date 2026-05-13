/**
 * `epicenter down`: stop a running `up` daemon.
 *
 * Default: shut down the daemon for the discovered project via IPC
 * `shutdown` (1 s budget).
 * If the daemon doesn't reply in time (hung handler, unresponsive socket),
 * fall back to `SIGTERM` against the recorded pid. `--all` enumerates every
 * daemon for the current user and shuts them down in parallel.
 *
 * No confirmation prompt: daemons are kill-friendly by design.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Process lifecycle".
 */

import { resolve } from 'node:path';
import {
	type DaemonMetadata,
	daemonClient,
	enumerateDaemons,
	readMetadata,
	socketPathFor,
	unlinkMetadata,
} from '@epicenter/workspace/node';
import { cmd } from '../util/cmd.js';
import { projectOption } from '../util/common-options.js';

const SHUTDOWN_TIMEOUT_MS = 1000;

// SIGTERM fallback only fires when the IPC shutdown didn't ack; we still
// guard the kill on pid liveness to avoid signaling a recycled pid.
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === 'EPERM';
	}
}

type Outcome =
	| { kind: 'graceful'; pid: number; dir: string }
	| { kind: 'sigterm'; pid: number; dir: string };

/**
 * Stop a single daemon by metadata. Tries IPC `shutdown` first; falls back
 * to `SIGTERM` after {@link SHUTDOWN_TIMEOUT_MS} ms or on any non-ok reply.
 */
async function shutdownOne(meta: DaemonMetadata): Promise<Outcome> {
	const sock = socketPathFor(meta.dir);
	const { error } = await daemonClient(sock, SHUTDOWN_TIMEOUT_MS).shutdown();
	if (!error) {
		return { kind: 'graceful', pid: meta.pid, dir: meta.dir };
	}

	// IPC didn't ack; fall back to SIGTERM if the pid is alive.
	if (isProcessAlive(meta.pid)) {
		try {
			process.kill(meta.pid, 'SIGTERM');
		} catch {
			// pid raced to exit between the alive check and the kill;
			// equivalent to graceful from our perspective.
		}
	}
	// Best-effort sweep; graceful shutdown would have removed these.
	unlinkMetadata(meta.dir);
	return { kind: 'sigterm', pid: meta.pid, dir: meta.dir };
}

export const downCommand = cmd({
	command: 'down',
	describe: 'Stop a running `epicenter up` daemon.',
	builder: {
		C: projectOption,
		all: {
			type: 'boolean',
			default: false,
			description: 'Stop every running daemon for this user.',
		},
	},
	handler: async (argv) => {
		if (argv.all) {
			const outcomes = await Promise.all(
				enumerateDaemons().map((m) => shutdownOne(m)),
			);
			process.stdout.write(
				`stopped ${outcomes.length} daemon${outcomes.length === 1 ? '' : 's'}\n`,
			);
			return;
		}

		const projectDir = resolve(argv.C);
		const meta = readMetadata(projectDir);
		if (!meta) {
			process.stderr.write(`no daemon running for ${projectDir}\n`);
			return;
		}

		const outcome = await shutdownOne(meta);
		if (outcome.kind === 'graceful') {
			process.stdout.write(`stopped (pid=${outcome.pid})\n`);
		} else {
			process.stderr.write(
				`shutdown timed out, sent SIGTERM (pid=${outcome.pid})\n`,
			);
		}
	},
});
