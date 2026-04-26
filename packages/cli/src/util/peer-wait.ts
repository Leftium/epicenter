/**
 * Find and wait for peers on the awareness wire.
 *
 * Every CLI command that targets a remote peer needs the same dance:
 * await `sync.whenConnected` so awareness can populate, then wait for
 * the answer to arrive (or the deadline to expire). `findPeer` is the
 * one-shot lookup; `waitForPeer` and `waitForAnyPeer` subscribe to
 * `awareness.observe()` so they react to changes without polling.
 *
 * `whenConnected` resolves after the sync handshake; the server
 * typically sends `AWARENESS(all clients)` in the same write window, so
 * a small grace period (callers default to 500ms for `list`/`peers`,
 * 5000ms for `run`) catches the burst plus any concurrent peer joins.
 *
 * `findPeer` matches by exact `device.id`. The per-installation deviceId
 * convention (`getOrCreateDeviceId`) makes collisions cryptographically
 * improbable, so "first match by clientID-asc" is correct rather than
 * ambiguous. No fuzzy matching, no kv-pair query DSL, no numeric
 * clientID escape hatch — the discovery flow is `epicenter peers` →
 * copy the deviceId → `--peer <id>`.
 */

import type { AwarenessState, LoadedWorkspace } from '../load-config';

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
		if (state.device.id === deviceId) {
			return { kind: 'found', clientID, state };
		}
	}
	return { kind: 'not-found' };
}

export type WaitForPeerResult =
	| { kind: 'found'; clientID: number; state: AwarenessState }
	| { kind: 'not-found'; sawPeers: boolean };

/**
 * Wait for a peer publishing `deviceId` to appear in awareness.
 * Subscribes to awareness changes — no polling — and resolves on first
 * match or when `deadline` expires.
 *
 * `sawPeers` is reported on the not-found branch so callers can
 * distinguish "no peers seen at all" from "peers seen but none matched"
 * in their error messages.
 */
export async function waitForPeer(
	workspace: LoadedWorkspace,
	deviceId: string,
	deadline: number,
): Promise<WaitForPeerResult> {
	if (workspace.sync?.whenConnected) await workspace.sync.whenConnected;

	const awareness = workspace.awareness;
	if (!awareness) return { kind: 'not-found', sawPeers: false };

	let sawPeers = false;
	const tryMatch = (): WaitForPeerResult | null => {
		const peers = awareness.peers();
		if (peers.size > 0) sawPeers = true;
		const found = findPeer(deviceId, peers);
		return found.kind === 'found' ? found : null;
	};

	const initial = tryMatch();
	if (initial) return initial;

	const remaining = deadline - Date.now();
	if (remaining <= 0) return { kind: 'not-found', sawPeers };

	return new Promise((resolve) => {
		const stop = awareness.observe(() => {
			const result = tryMatch();
			if (result) {
				clearTimeout(timer);
				stop();
				resolve(result);
			}
		});
		const timer = setTimeout(() => {
			stop();
			resolve({ kind: 'not-found', sawPeers });
		}, remaining);
	});
}

/**
 * Wait for awareness to show *any* peer, up to the deadline. Best-effort:
 * resolves when at least one peer is visible OR the deadline expires.
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

	const awareness = workspace.awareness;
	if (!awareness) return;

	if (awareness.peers().size > 0) return;

	const remaining = deadline - Date.now();
	if (remaining <= 0) return;

	return new Promise((resolve) => {
		const stop = awareness.observe(() => {
			if (awareness.peers().size > 0) {
				clearTimeout(timer);
				stop();
				resolve();
			}
		});
		const timer = setTimeout(() => {
			stop();
			resolve();
		}, remaining);
	});
}
