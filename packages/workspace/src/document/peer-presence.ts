import { Ok, type Result } from 'wellcrafted/result';
import type {
	AwarenessAttachment,
	AwarenessSchema,
} from './attach-awareness.js';
import { PeerMiss, type SyncStatus } from './attach-sync.js';
import {
	PeerIdentity,
	type PeerPresenceState,
	type ResolvedPeer,
} from './peer-presence-defs.js';

export type PeerDirectory = {
	peers(): Map<number, PeerPresenceState>;
	find(peerId: string): ResolvedPeer | undefined;
	waitForPeer(
		peerId: string,
		options: { timeoutMs: number },
	): Promise<Result<ResolvedPeer, PeerMiss>>;
	observe(callback: () => void): () => void;
};

export function createPeerDirectory<
	TSchema extends AwarenessSchema & { peer: typeof PeerIdentity },
>({
	awareness,
	sync,
}: {
	awareness: AwarenessAttachment<TSchema>;
	sync: { readonly status: SyncStatus };
}): PeerDirectory {
	function peerStates(): Map<number, PeerPresenceState> {
		const result = new Map<number, PeerPresenceState>();
		for (const [clientId, state] of awareness.peers()) {
			result.set(clientId, { peer: state.peer });
		}
		return result;
	}

	function find(peerId: string): ResolvedPeer | undefined {
		const all = peerStates();
		const sorted = [...all.keys()].sort((a, b) => a - b);
		for (const clientId of sorted) {
			const state = all.get(clientId)!;
			if (state.peer.id === peerId) {
				return { clientId, state };
			}
		}
		return undefined;
	}

	return {
		peers: peerStates,
		find,
		async waitForPeer(peerId, { timeoutMs }) {
			let sawPeers = false;
			const tryMatch = (): ResolvedPeer | undefined => {
				const all = peerStates();
				if (all.size > 0) sawPeers = true;
				const sorted = [...all.keys()].sort((a, b) => a - b);
				for (const clientId of sorted) {
					const state = all.get(clientId)!;
					if (state.peer.id === peerId) return { clientId, state };
				}
				return undefined;
			};

			const initial = tryMatch();
			if (initial) return Ok(initial);

			if (timeoutMs <= 0) {
				return PeerMiss.PeerMiss({
					peerTarget: peerId,
					sawPeers,
					waitMs: timeoutMs,
					emptyReason: describeOfflineReason(sync.status),
				});
			}

			return new Promise((resolve) => {
				const stop = awareness.observe(() => {
					const hit = tryMatch();
					if (hit) {
						clearTimeout(timer);
						stop();
						resolve(Ok(hit));
					}
				});
				const timer = setTimeout(() => {
					stop();
					resolve(
						PeerMiss.PeerMiss({
							peerTarget: peerId,
							sawPeers,
							waitMs: timeoutMs,
							emptyReason: describeOfflineReason(sync.status),
						}),
					);
				}, timeoutMs);
			});
		},
		observe(callback) {
			return awareness.observe(callback);
		},
	};
}

function describeOfflineReason(status: SyncStatus): string | null {
	if (status.phase === 'connected') return null;
	if (status.phase === 'connecting' && status.lastError) {
		const retries = status.retries;
		const word = retries === 1 ? 'retry' : 'retries';
		return `not connected (${status.lastError.type} error after ${retries} ${word})`;
	}
	return 'not connected';
}
