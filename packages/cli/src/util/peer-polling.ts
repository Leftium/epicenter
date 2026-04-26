/**
 * Find and wait for peers on the awareness wire.
 *
 * Every CLI command that targets a remote peer needs the same dance:
 * await `sync.whenConnected` so awareness can populate, then poll until
 * either the answer arrives or the deadline expires. `findPeer` is the
 * one-shot lookup; `waitForPeer` and `waitForAnyPeer` are the polling
 * variants that wrap it.
 *
 * `whenConnected` resolves after the sync handshake; the server typically
 * sends `AWARENESS(all clients)` in the same write window, so a small
 * grace period (callers default to 500ms for `list`/`peers`, 5000ms for
 * `run`) catches the burst plus any concurrent peer joins.
 *
 * `findPeer` matches by exact `device.id`. The per-installation deviceId
 * convention (`getOrCreateDeviceId`) makes collisions cryptographically
 * improbable, so "first match by clientID-asc" is correct rather than
 * ambiguous. No fuzzy matching, no kv-pair query DSL, no numeric
 * clientID escape hatch — the discovery flow is `epicenter peers` →
 * copy the deviceId → `--peer <id>`.
 */

import type { LoadedWorkspace } from '../load-config';
import { type AwarenessState, readPeers } from './awareness';

const POLL_INTERVAL_MS = 100;

export type FindPeerResult =
	| { kind: 'found'; clientID: number; state: AwarenessState }
	| { kind: 'not-found' };

/** One-shot exact-match lookup by `device.id`. First match by clientID-asc. */
export function findPeer(
	deviceId: string,
	peers: Map<number, AwarenessState>,
): FindPeerResult {
	const sorted = [...peers.keys()].sort((a, b) => a - b);
	for (const clientID of sorted) {
		const state = peers.get(clientID)!;
		if (state.device?.id === deviceId) {
			return { kind: 'found', clientID, state };
		}
	}
	return { kind: 'not-found' };
}

/**
 * Wait for a single peer to appear by deviceId. Returns the resolved
 * awareness state, or `not-found` once `deadline` is reached.
 *
 * Takes an absolute `deadline` (ms timestamp) rather than a relative
 * duration so callers can share one budget across multiple phases —
 * `run --peer` uses the same deadline for peer resolution and the
 * follow-up RPC, which keeps the time-accounting straight without
 * duplicating `Date.now() + waitMs` in two places.
 *
 * `sawPeers` is reported on the not-found branch so callers can
 * distinguish "no peers seen at all" from "peers seen but none matched"
 * in their error messages.
 */
export type WaitForPeerResult =
	| { kind: 'found'; clientID: number; state: AwarenessState }
	| { kind: 'not-found'; sawPeers: boolean };

export async function waitForPeer(
	workspace: LoadedWorkspace,
	deviceId: string,
	deadline: number,
): Promise<WaitForPeerResult> {
	if (workspace.sync?.whenConnected) await workspace.sync.whenConnected;

	let sawPeers = false;
	while (true) {
		const peers = readPeers(workspace);
		if (peers.size > 0) sawPeers = true;
		const found = findPeer(deviceId, peers);
		if (found.kind === 'found') {
			return { kind: 'found', clientID: found.clientID, state: found.state };
		}
		if (Date.now() >= deadline) return { kind: 'not-found', sawPeers };
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
}

/**
 * Wait for awareness to show *any* peer, up to the deadline. Best-effort:
 * returns when at least one peer is visible OR the deadline expires.
 *
 * Returns void deliberately. The caller decides freshness — call
 * `readPeers(workspace)` after this resolves to get the snapshot. This
 * keeps the contract honest: an in-flight peer might appear between
 * "wait satisfied" and "use the snapshot," and pretending otherwise
 * would cache a value that's already a hair stale at return.
 */
export async function waitForAnyPeer(
	workspace: LoadedWorkspace,
	deadline: number,
): Promise<void> {
	if (workspace.sync?.whenConnected) await workspace.sync.whenConnected;

	while (true) {
		if (readPeers(workspace).size > 0 || Date.now() >= deadline) return;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
}
