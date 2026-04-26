/**
 * Awareness polling — the single source of truth across `list`, `peers`,
 * and `run`. Every CLI command that targets a remote peer needs the same
 * dance: await `sync.whenConnected` so awareness can populate, then poll
 * until either the deadline expires or the answer arrives.
 *
 * `whenConnected` resolves after the sync handshake; the server typically
 * sends `AWARENESS(all clients)` in the same write window, so a small
 * grace period (callers default to 500ms for `list`/`peers`, 5000ms for
 * `run`) catches the burst plus any concurrent peer joins.
 */

import type { LoadedWorkspace } from '../load-config';
import { type AwarenessState, readPeers } from './awareness';
import { findPeer } from './find-peer';

const POLL_INTERVAL_MS = 100;

/**
 * Wait for a single peer to appear by deviceId. Returns the resolved
 * awareness state, or `null` if the deadline expired with no match.
 *
 * `sawPeers` is reported separately so callers (e.g. `run --peer`) can
 * distinguish "no peers seen at all" from "peers seen but none matched"
 * in their error messages.
 */
export type WaitForPeerResult =
	| { kind: 'found'; clientID: number; state: AwarenessState; sawPeers: true }
	| { kind: 'not-found'; sawPeers: boolean };

export async function waitForPeer(
	workspace: LoadedWorkspace,
	deviceId: string,
	waitMs: number,
): Promise<WaitForPeerResult> {
	if (workspace.sync?.whenConnected) await workspace.sync.whenConnected;

	const deadline = Date.now() + waitMs;
	let sawPeers = false;
	while (true) {
		const peers = readPeers(workspace);
		if (peers.size > 0) sawPeers = true;
		const found = findPeer(deviceId, peers);
		if (found.kind === 'found') {
			return {
				kind: 'found',
				clientID: found.clientID,
				state: found.state,
				sawPeers: true,
			};
		}
		if (Date.now() >= deadline) return { kind: 'not-found', sawPeers };
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
}

/**
 * Wait for awareness to show *any* peer, up to the deadline. Returns the
 * snapshot of peers seen at the time of return (possibly empty — for
 * `--all` we want to render even when no peers showed up).
 *
 * Differs from `waitForPeer` in that it never returns "not-found": the
 * caller always gets a snapshot, just possibly an empty one.
 */
export async function waitForAnyPeer(
	workspace: LoadedWorkspace,
	waitMs: number,
): Promise<Map<number, AwarenessState>> {
	if (workspace.sync?.whenConnected) await workspace.sync.whenConnected;

	const deadline = Date.now() + waitMs;
	while (true) {
		const peers = readPeers(workspace);
		if (peers.size > 0 || Date.now() >= deadline) return peers;
		await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
	}
}
