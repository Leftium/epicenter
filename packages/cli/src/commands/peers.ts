/**
 * `epicenter peers` — list who you can run `--peer` against.
 *
 * For each workspace entry (or a single entry narrowed by `-w`):
 *   1. await `handle.sync.whenConnected` (awareness requires the transport)
 *   2. snapshot `awareness.getStates()`, or poll up to `--wait <ms>` if the
 *      snapshot is empty (default: 0 = true one-shot)
 *   3. emit a `console.table` (default) or JSON (`--format json`)
 *
 * This is a snapshot, not a registry. A peer that hasn't broadcast its
 * awareness state is invisible — pass `--wait 2000` to give slow peers a
 * chance before emitting. See `handle-attachments.ts` for awareness
 * invariants (~30s TTL, session-local clientID).
 *
 * Prints `no peers connected` to stderr when every workspace is empty (text
 * mode only; JSON mode always emits a valid array, even if empty).
 */

import type { Argv, CommandModule } from 'yargs';
import { loadConfig, type LoadConfigResult } from '../load-config';
import {
	dirFromArgv,
	dirOption,
	workspaceFromArgv,
	workspaceOption,
} from '../util/common-options';
import { formatYargsOptions, output } from '../util/format-output';
import {
	getSync,
	readPeers,
	type AwarenessState,
} from '../util/handle-attachments';
import { resolveEntry } from '../util/resolve-entry';

const POLL_INTERVAL_MS = 100;
const DEFAULT_WAIT_MS = 0;

type PeerRow = { clientID: number } & Record<string, unknown>;

type WorkspaceSnapshot = {
	name: string;
	peers: Map<number, AwarenessState>;
};

export const peersCommand: CommandModule = {
	command: 'peers',
	describe: 'List peers you can target with `run --peer`',
	builder: (yargs: Argv) =>
		yargs
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.option('wait', {
				type: 'number',
				default: DEFAULT_WAIT_MS,
				description: `Ms to wait for awareness to populate (default ${DEFAULT_WAIT_MS} = one-shot snapshot)`,
			})
			.options(formatYargsOptions()),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const workspaceArg = workspaceFromArgv(args);
		const waitMs = typeof args.wait === 'number' ? args.wait : DEFAULT_WAIT_MS;
		const format = args.format as 'json' | 'jsonl' | undefined;
		const { entries, dispose } = await loadConfig(dirFromArgv(args));
		try {
			const selected: LoadConfigResult['entries'] = workspaceArg
				? [resolveEntry(entries, workspaceArg)]
				: entries;

			const snapshots = await Promise.all(
				selected.map((e) => snapshotEntry(e, waitMs)),
			);
			emit(snapshots, { elideHeader: workspaceArg !== undefined, format });
		} finally {
			await dispose();
		}
	},
};

async function snapshotEntry(
	entry: LoadConfigResult['entries'][number],
	waitMs: number,
): Promise<WorkspaceSnapshot> {
	const sync = getSync(entry.handle);
	if (sync?.whenConnected) await sync.whenConnected;

	const deadline = Date.now() + waitMs;
	while (true) {
		const peers = readPeers(entry.handle);
		if (peers.size > 0 || Date.now() >= deadline) {
			return { name: entry.name, peers };
		}
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
}

function emit(
	snapshots: WorkspaceSnapshot[],
	{
		elideHeader,
		format,
	}: { elideHeader: boolean; format: 'json' | 'jsonl' | undefined },
): void {
	if (format === 'json' || format === 'jsonl') {
		const flat = snapshots.flatMap(({ name, peers }) =>
			buildPeerRows(peers).map((row) => ({ workspace: name, ...row })),
		);
		output(flat, { format });
		return;
	}

	const nonEmpty = snapshots.filter((s) => s.peers.size > 0);
	if (nonEmpty.length === 0) {
		console.error('no peers connected');
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
