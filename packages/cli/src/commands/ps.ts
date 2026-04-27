/**
 * `epicenter ps` — list running `up` daemons (this user, this machine).
 *
 * Enumerates `<runtimeDir>/*.meta.json`, pings each socket to confirm
 * liveness, and renders a compact table. Dead-pid metadata files are
 * opportunistically swept (same orphan path as `inspectExistingDaemon`).
 *
 * No `--json` flag in v1 — the spec defers it until a tooling consumer
 * (Conductor panel, shell prompt) asks.
 *
 * See spec: `20260426T235000-cli-up-long-lived-peer.md` § "Process lifecycle".
 */

import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { CommandModule } from 'yargs';

import { ipcPing } from '../daemon/ipc-client.js';
import {
	type DaemonMetadata,
	isProcessAlive,
	readMetadataFromPath,
	unlinkMetadata,
} from '../daemon/metadata.js';
import { runtimeDir, socketPathFor } from '../daemon/paths.js';
import { CONFIG_FILENAME } from '../load-config.js';

/** A row of the `ps` table. */
export type PsRow = {
	dir: string;
	deviceId: string;
	workspace: string;
	pid: number;
	uptime: string;
	configChanged: boolean | '?';
};

/** Test seam — matches the production `ipcPing` signature. */
export type RunPsDeps = {
	ipcPing?: (socketPath: string, timeoutMs?: number) => Promise<boolean>;
};

/**
 * Body of `ps`. Returns the rows the table renderer prints. Dead-pid
 * metadata files are unlinked as a side effect (along with any phantom
 * socket files) before the function returns.
 */
export async function runPs(deps: RunPsDeps = {}): Promise<PsRow[]> {
	const ping = deps.ipcPing ?? ipcPing;
	const root = runtimeDir();
	if (!existsSync(root)) return [];

	const names = readdirSync(root).filter((n) => n.endsWith('.meta.json'));

	const rows: PsRow[] = [];
	for (const name of names) {
		const meta = readMetadataFromPath(join(root, name));
		if (!meta) continue;

		// Dead pid → orphan: unlink metadata + socket and skip.
		if (!isProcessAlive(meta.pid)) {
			sweepOrphan(meta);
			continue;
		}

		// Pid alive but socket unresponsive → also orphan.
		const sockPath = socketPathFor(meta.dir);
		const responsive = await ping(sockPath, 250);
		if (!responsive) {
			sweepOrphan(meta);
			continue;
		}

		rows.push({
			dir: meta.dir,
			deviceId: meta.deviceId,
			workspace: meta.workspace,
			pid: meta.pid,
			uptime: humanUptime(meta.startedAt),
			configChanged: detectConfigChange(meta),
		});
	}
	return rows;
}

function sweepOrphan(meta: DaemonMetadata): void {
	unlinkMetadata(meta.dir);
	const sockPath = socketPathFor(meta.dir);
	if (existsSync(sockPath)) {
		try {
			unlinkSync(sockPath);
		} catch {
			// best effort
		}
	}
}

/**
 * `'?'` when the config file is missing (e.g. workspace dir was renamed),
 * `true` when its mtime differs from the captured value, `false` otherwise.
 */
function detectConfigChange(meta: DaemonMetadata): boolean | '?' {
	const p = join(meta.dir, CONFIG_FILENAME);
	if (!existsSync(p)) return '?';
	try {
		return statSync(p).mtimeMs !== meta.configMtime;
	} catch {
		return '?';
	}
}

function humanUptime(startedAt: string): string {
	const ms = Date.now() - new Date(startedAt).getTime();
	if (Number.isNaN(ms) || ms < 0) return '0s';
	const sec = Math.floor(ms / 1000);
	if (sec < 60) return `${sec}s`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hr = Math.floor(min / 60);
	const restMin = min % 60;
	return `${hr}h${restMin}m`;
}

export const psCommand: CommandModule = {
	command: 'ps',
	describe: 'List running `epicenter up` daemons (this user, this machine).',
	builder: (yargs) => yargs,
	handler: async () => {
		const rows = await runPs();
		if (rows.length === 0) {
			process.stderr.write('no daemons running\n');
			return;
		}
		// `console.table` is the spec-mentioned renderer; it writes to stdout.
		console.table(rows);
	},
};
