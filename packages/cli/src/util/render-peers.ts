/**
 * Build and print `console.table` snapshots of awareness peers grouped by
 * workspace.
 *
 * Render rules:
 *   1. Group peers by workspace (caller supplies groups).
 *   2. Column `clientID` first; remaining columns are the alphabetical union
 *      of awareness keys in that workspace.
 *   3. Rows sorted by `clientID` ASC.
 *   4. Missing fields render as blank.
 *   5. Workspace header printed unless `elideHeader` is true.
 *   6. An empty list prints `no peers connected`.
 */
import type { AwarenessState } from './find-peer';

export type PeerRow = { clientID: number } & Record<string, unknown>;

export type WorkspacePeers = {
	name: string;
	peers: Map<number, AwarenessState>;
};

export type RenderSink = {
	log: (message: string) => void;
	table: (rows: unknown[]) => void;
};

const DEFAULT_SINK: RenderSink = {
	log: (m) => console.log(m),
	table: (rows) => console.table(rows),
};

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

export function renderPeers(
	workspaces: WorkspacePeers[],
	options: { elideHeader?: boolean; sink?: RenderSink } = {},
): void {
	const sink = options.sink ?? DEFAULT_SINK;
	const elideHeader = options.elideHeader ?? false;

	const nonEmpty = workspaces.filter((w) => w.peers.size > 0);

	if (nonEmpty.length === 0) {
		sink.log('no peers connected');
		return;
	}

	for (let i = 0; i < nonEmpty.length; i++) {
		const { name, peers } = nonEmpty[i]!;
		if (!elideHeader) {
			if (i > 0) sink.log('');
			sink.log(name);
		}
		sink.table(buildPeerRows(peers));
	}
}
