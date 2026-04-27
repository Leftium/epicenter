/**
 * Find and wait for peers on the sync wire.
 *
 * `findPeer` is a one-shot lookup; `waitForPeer` and `waitForAnyPeer`
 * subscribe to `sync.observe()` so they react to changes without polling
 * and bail when `deadline` expires. They deliberately do NOT block on
 * `sync.whenConnected` — the observe loop already covers that path
 * (awareness can only arrive after the WS handshake completes), and
 * pre-awaiting `whenConnected` would hang forever when the server is
 * unreachable or rejects auth, ignoring the caller's `--wait` budget.
 *
 * `findPeer` matches by exact `device.id`. The per-installation deviceId
 * convention (`getOrCreateDeviceId`) makes collisions cryptographically
 * improbable, so "first match by clientID-asc" is correct rather than
 * ambiguous. No fuzzy matching, no kv-pair query DSL, no numeric
 * clientID escape hatch — the discovery flow is `epicenter peers` →
 * copy the deviceId → `--peer <id>`.
 */

import type { AwarenessState, LoadedWorkspace } from '../load-config';

/**
 * Explain why no peers are visible, by inspecting the live sync status.
 * Returns `null` when the connection is healthy (peers are simply absent —
 * nothing to explain) or when no sync is attached at all.
 *
 * Surfacing this matters because `whenConnected` may never resolve (server
 * down, stale prod, auth rejected), and without this hint the CLI just
 * prints `no peers connected` after the wait expires — indistinguishable
 * from "everything is fine, you're alone".
 */
export function explainEmpty(workspace: LoadedWorkspace): string | null {
	const status = workspace.sync?.status;
	if (!status || status.phase === 'connected') return null;
	if (status.phase === 'connecting' && status.lastError) {
		return `not connected (${status.lastError.type} error after ${status.retries} ${status.retries === 1 ? 'retry' : 'retries'})`;
	}
	return 'not connected';
}

export type PeerHit = { clientID: number; state: AwarenessState };

/** One-shot exact-match lookup by `device.id`. First match by clientID-asc. */
export function findPeer(
	deviceId: string,
	peers: Map<number, AwarenessState>,
): PeerHit | null {
	const sorted = [...peers.keys()].sort((a, b) => a - b);
	for (const clientID of sorted) {
		const state = peers.get(clientID)!;
		if (state.device.id === deviceId) return { clientID, state };
	}
	return null;
}

/**
 * `hit` is the match (or `null`); `sawPeers` reports whether *any* peers
 * were ever visible during the wait, so callers can distinguish "no peers
 * at all" from "peers seen but none matched" in error messages.
 */
export type WaitForPeerResult = { hit: PeerHit | null; sawPeers: boolean };

/**
 * Wait for a peer publishing `deviceId` to appear in awareness.
 * Subscribes to awareness changes — no polling — and resolves on first
 * match or when `deadline` expires.
 */
export async function waitForPeer(
	workspace: LoadedWorkspace,
	deviceId: string,
	deadline: number,
): Promise<WaitForPeerResult> {
	const sync = workspace.sync;
	if (!sync) return { hit: null, sawPeers: false };

	let sawPeers = false;
	const tryMatch = (): PeerHit | null => {
		const list = sync.peers();
		if (list.size > 0) sawPeers = true;
		return findPeer(deviceId, list);
	};

	const initial = tryMatch();
	if (initial) return { hit: initial, sawPeers };

	const remaining = deadline - Date.now();
	if (remaining <= 0) return { hit: null, sawPeers };

	return new Promise((resolve) => {
		const stop = sync.observe(() => {
			const hit = tryMatch();
			if (hit) {
				clearTimeout(timer);
				stop();
				resolve({ hit, sawPeers });
			}
		});
		const timer = setTimeout(() => {
			stop();
			resolve({ hit: null, sawPeers });
		}, remaining);
	});
}

/**
 * Wait for presence to show *any* peer, up to the deadline. Best-effort:
 * resolves when at least one peer is visible OR the deadline expires.
 *
 * Returns void deliberately. The caller decides freshness — call
 * `workspace.sync?.peers()` after this resolves to get the snapshot.
 * This keeps the contract honest: an in-flight peer might appear between
 * "wait satisfied" and "use the snapshot," and pretending otherwise
 * would cache a value that's already a hair stale at return.
 */
export async function waitForAnyPeer(
	workspace: LoadedWorkspace,
	deadline: number,
): Promise<void> {
	const sync = workspace.sync;
	if (!sync) return;
	if (sync.peers().size > 0) return;

	const remaining = deadline - Date.now();
	if (remaining <= 0) return;

	return new Promise((resolve) => {
		const stop = sync.observe(() => {
			if (sync.peers().size > 0) {
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
