/**
 * `epicenter peers` — presence-only view of who's connected right now.
 *
 * Shows just the identity fields needed to target a peer with
 * `run --peer` or `list --peer`: deviceId, friendly name, platform, and the
 * session-local clientID. Action introspection lives in `list --peer` and
 * `list --all` — this command stays narrow.
 *
 * For each workspace entry (or a single entry narrowed by `-w`):
 *   1. await `workspace.sync.whenConnected` (presence rides the transport)
 *   2. snapshot `workspace.sync.peers()`, or poll up to `--wait <ms>`
 *      if the snapshot is empty
 *   3. emit a `console.table` (default) or JSON (`--format json`)
 *
 * This is a snapshot, not a registry. A peer that hasn't broadcast its
 * awareness state is invisible — pass `--wait 2000` to give slow peers a
 * chance before emitting. Awareness has a ~30s TTL and session-local
 * clientIDs; see `attachAwareness` in `@epicenter/workspace`.
 *
 * Prints `no peers connected` to stderr when every workspace is empty (text
 * mode only; JSON mode always emits a valid array, even if empty).
 */

import type { Argv, CommandModule } from 'yargs';
import {
	type AwarenessState,
	loadConfig,
	type WorkspaceEntry,
} from '../load-config';
import {
	dirFromArgv,
	dirOption,
	workspaceFromArgv,
	workspaceOption,
} from '../util/common-options';
import { formatYargsOptions, output } from '../util/format-output';
import { explainEmpty, waitForAnyPeer } from '../util/peer-wait';
import { resolveEntry } from '../util/resolve-entry';

const DEFAULT_WAIT_MS = 500;

type PeerRow = {
	clientID: number;
	deviceId: string;
	name: string;
	platform: string;
};

type WorkspaceSnapshot = {
	name: string;
	peers: Map<number, AwarenessState>;
	entry: WorkspaceEntry;
};

export const peersCommand: CommandModule = {
	command: 'peers',
	describe:
		'List connected peers (presence). Use `list --peer` or `list --all` for action introspection.',
	builder: (yargs: Argv) =>
		yargs
			.option('dir', dirOption)
			.option('workspace', workspaceOption)
			.option('wait', {
				type: 'number',
				default: DEFAULT_WAIT_MS,
				description: `Ms to wait for awareness to populate (default ${DEFAULT_WAIT_MS}; pass 0 for a one-shot snapshot)`,
			})
			.option('no-up', {
				type: 'boolean',
				default: false,
				description:
					'Skip the `epicenter up` daemon if one is running and use a transient connection instead',
			})
			.options(formatYargsOptions()),
	handler: async (argv) => {
		const args = argv as Record<string, unknown>;
		const workspaceArg = workspaceFromArgv(args);
		const waitMs = typeof args.wait === 'number' ? args.wait : DEFAULT_WAIT_MS;
		const format = args.format as 'json' | 'jsonl' | undefined;
		await using config = await loadConfig(dirFromArgv(args));
		const selected: WorkspaceEntry[] = workspaceArg
			? [resolveEntry(config.entries, workspaceArg)]
			: config.entries;

		const snapshots = await Promise.all(
			selected.map((e) => snapshotEntry(e, waitMs)),
		);
		emit(snapshots, { elideHeader: workspaceArg !== undefined, format });
	},
};

async function snapshotEntry(
	entry: WorkspaceEntry,
	waitMs: number,
): Promise<WorkspaceSnapshot> {
	await waitForAnyPeer(entry.workspace, Date.now() + waitMs);
	const peers =
		entry.workspace.sync?.peers() ?? new Map<number, AwarenessState>();
	return { name: entry.name, peers, entry };
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
		// Surface a connect-status hint per workspace if any are still trying —
		// turns "silent timeout" into "oh, the server rejected us".
		for (const { name, entry } of snapshots) {
			const why = explainEmpty(entry.workspace);
			if (why) console.error(`  ${name}: ${why}`);
		}
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

/**
 * Project each awareness state to a presence row. Awareness carries
 * presence-only `device.{id, name, platform}` — action manifests are
 * fetched on demand by `list --peer` / `list --all`.
 */
export function buildPeerRows(peers: Map<number, AwarenessState>): PeerRow[] {
	const rows: PeerRow[] = [];
	for (const [clientID, { device }] of peers) {
		rows.push({
			clientID,
			deviceId: device.id,
			name: device.name,
			platform: device.platform,
		});
	}
	rows.sort((a, b) => a.clientID - b.clientID);
	return rows;
}
