/**
 * `epicenter peers` — list who you can run `--peer` against.
 *
 * For each workspace entry (or a single entry narrowed by `-w`):
 *   1. await `handle.sync.whenConnected` (awareness requires the transport)
 *   2. snapshot `awareness.getStates()` and print a `console.table`
 *
 * This is a one-shot snapshot, not a registry. A peer that hasn't broadcast
 * its awareness state by the time `whenConnected` resolves will not appear —
 * re-run the command. See `handle-attachments.ts` for awareness invariants.
 *
 * Prints `no peers connected` when every workspace's snapshot is empty.
 */

import type { Argv, CommandModule } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
import { dirFromArgv, dirOption } from '../util/dir-option';
import {
	getSync,
	readPeers,
	type AwarenessState,
} from '../util/handle-attachments';
import { resolveEntry } from '../util/resolve-entry';
import { workspaceFromArgv, workspaceOption } from '../util/workspace-option';

type PeerRow = { clientID: number } & Record<string, unknown>;

type WorkspaceSnapshot = {
	name: string;
	peers: Map<number, AwarenessState>;
};

export const peersCommand: CommandModule = {
	command: 'peers',
	describe: 'List peers you can target with `run --peer`',
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
			printSnapshots(snapshots, { elideHeader: workspaceArg !== undefined });
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
): Promise<WorkspaceSnapshot> {
	const sync = getSync(entry.handle);
	if (sync?.whenConnected) await sync.whenConnected;
	return { name: entry.name, peers: readPeers(entry.handle) };
}

function printSnapshots(
	snapshots: WorkspaceSnapshot[],
	{ elideHeader }: { elideHeader: boolean },
): void {
	const nonEmpty = snapshots.filter((s) => s.peers.size > 0);
	if (nonEmpty.length === 0) {
		console.log('no peers connected');
		return;
	}
	for (let i = 0; i < nonEmpty.length; i++) {
		const { name, peers } = nonEmpty[i]!;
		if (!elideHeader) {
			if (i > 0) console.log('');
			console.log(name);
		}
		console.table(buildPeerRows(peers));
	}
}

export function buildPeerRows(peers: Map<number, AwarenessState>): PeerRow[] {
	const keys = new Set<string>();
	for (const state of peers.values()) {
		for (const key of Object.keys(state)) keys.add(key);
	}
	const sortedKeys = [...keys].sort();

	const rows: PeerRow[] = [];
	for (const [clientID, state] of peers) {
		const row: PeerRow = { clientID };
		for (const key of sortedKeys) {
			row[key] = key in state ? state[key] : '';
		}
		rows.push(row);
	}
	rows.sort((a, b) => a.clientID - b.clientID);
	return rows;
}
