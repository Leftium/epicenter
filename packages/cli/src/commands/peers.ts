/**
 * `epicenter peers` — enumerate remote peers connected to each workspace.
 *
 * For each workspace entry (or a single entry narrowed by `-w`):
 *   1. await `handle.sync.whenConnected` (remote awareness requires transport)
 *   2. wait 500ms for peers to settle
 *   3. snapshot `awareness.getStates()` and render one `console.table` per
 *      workspace
 *
 * Prints `no peers connected` when every workspace's snapshot is empty.
 */

import type { Argv, CommandModule } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
import { dirFromArgv, dirOption } from '../util/dir-option';
import { getSync, readPeers } from '../util/handle-peers';
import { renderPeers, type WorkspacePeers } from '../util/render-peers';
import { resolveEntry } from '../util/resolve-entry';
import { workspaceFromArgv, workspaceOption } from '../util/workspace-option';

const SETTLE_MS = 500;

export const peersCommand: CommandModule = {
	command: 'peers',
	describe: 'Enumerate remote peers connected per workspace',
	builder: (yargs: Argv) =>
		yargs.option('dir', dirOption).option('workspace', workspaceOption),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const workspaceArg = workspaceFromArgv(args);
		const { entries, dispose } = await loadConfig(dirFromArgv(args));
		try {
			const selected: LoadConfigResult['entries'] = workspaceArg
				? [resolveEntry(entries, workspaceArg)]
				: entries;

			const snapshots = await Promise.all(selected.map(snapshotEntry));

			renderPeers(snapshots, { elideHeader: workspaceArg !== undefined });
		} finally {
			await dispose();
			await Promise.all(
				entries.map(async (entry) => {
					const sync = getSync(entry.handle);
					if (sync?.whenDisposed) await sync.whenDisposed;
				}),
			);
		}
	},
};

async function snapshotEntry(
	entry: LoadConfigResult['entries'][number],
): Promise<WorkspacePeers> {
	const sync = getSync(entry.handle);
	if (sync?.whenConnected) await sync.whenConnected;
	await new Promise((r) => setTimeout(r, SETTLE_MS));
	return { name: entry.name, peers: readPeers(entry.handle) };
}
