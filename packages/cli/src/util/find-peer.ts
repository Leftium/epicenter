/**
 * Resolve a `--peer <deviceId>` flag against a map of awareness states.
 *
 * One mode: exact `device.id` match. Walks peers in clientID-ascending order
 * and returns the first match. The per-installation deviceId convention
 * (`getOrCreateDeviceId`) makes collisions cryptographically improbable, so
 * "first match wins" is correct rather than ambiguous.
 *
 * No fuzzy matching, no kv-pair query DSL, no numeric clientID escape hatch.
 * Discovery flow is `epicenter peers` → copy the deviceId → `--peer <id>`.
 */
import type { AwarenessState } from './awareness';

export type FindPeerResult =
	| { kind: 'found'; clientID: number; state: AwarenessState }
	| { kind: 'not-found' };

export function findPeer(
	deviceId: string,
	peers: Map<number, AwarenessState>,
): FindPeerResult {
	const sorted = [...peers.keys()].sort((a, b) => a - b);
	for (const clientID of sorted) {
		const state = peers.get(clientID)!;
		const peerDeviceId = (state.device as { id?: string } | undefined)?.id;
		if (peerDeviceId === deviceId) return { kind: 'found', clientID, state };
	}
	return { kind: 'not-found' };
}
