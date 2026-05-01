import { Ok, type Result } from 'wellcrafted/result';
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
	Awareness as YAwareness,
} from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
	encodeAwareness,
	encodeAwarenessStates,
	SYNC_ORIGIN,
} from '@epicenter/sync';
import { createAwareness, type Awareness } from './attach-awareness.js';
import {
	PeerIdentity,
	type ResolvedPeer,
	type PeerPresenceState,
} from './peer-presence-defs.js';
import type { PeerMiss, SyncStatus } from './attach-sync.js';

export type PeerPresenceAttachment = {
	peers(): Map<number, PeerPresenceState>;
	find(peerId: string): ResolvedPeer | undefined;
	waitForPeer(
		peerId: string,
		options: { timeoutMs: number },
	): Promise<Result<ResolvedPeer, PeerMiss>>;
	observe(callback: () => void): () => void;
	raw: { awareness: YAwareness };
};

export type AttachPresenceConfig = {
	peer: PeerIdentity;
};

export type PeerPresenceController = {
	awareness: YAwareness;
	handleRemoteUpdate(update: Uint8Array): void;
	sendLocalState(): void;
	sendKnownStates(): void;
	removeRemoteStates(): void;
	dispose(): void;
};

type PeerPresenceInternals = {
	ydoc: Y.Doc;
	send(message: Uint8Array): void;
	status(): SyncStatus;
	createPeerMiss(input: {
		peerTarget: string;
		sawPeers: boolean;
		waitMs: number;
		emptyReason: string | null;
	}): Result<ResolvedPeer, PeerMiss>;
	describeOfflineReason(status: SyncStatus): string | null;
};

const peerPresenceDefs = { peer: PeerIdentity };

export function createPeerPresence(
	config: AttachPresenceConfig,
	internals: PeerPresenceInternals,
): PeerPresenceAttachment & { controller: PeerPresenceController } {
	const awareness = new YAwareness(internals.ydoc);
	const typedAwareness = createAwareness(awareness, peerPresenceDefs);
	typedAwareness.setLocal({ peer: config.peer });

	function handleAwarenessUpdate(
		{
			added,
			updated,
			removed,
		}: { added: number[]; updated: number[]; removed: number[] },
		origin: unknown,
	) {
		if (origin === SYNC_ORIGIN) return;
		const changedClients = added.concat(updated).concat(removed);
		internals.send(
			encodeAwareness({
				update: encodeAwarenessUpdate(awareness, changedClients),
			}),
		);
	}

	awareness.on('update', handleAwarenessUpdate);

	const controller: PeerPresenceController = {
		awareness,
		handleRemoteUpdate(update) {
			applyAwarenessUpdate(awareness, update, SYNC_ORIGIN);
		},
		sendLocalState() {
			if (awareness.getLocalState() === null) return;
			internals.send(
				encodeAwarenessStates({
					awareness,
					clients: [internals.ydoc.clientID],
				}),
			);
		},
		sendKnownStates() {
			internals.send(
				encodeAwarenessStates({
					awareness,
					clients: Array.from(awareness.getStates().keys()),
				}),
			);
		},
		removeRemoteStates() {
			const remoteClientIds = Array.from(awareness.getStates().keys()).filter(
				(clientId) => clientId !== internals.ydoc.clientID,
			);
			if (remoteClientIds.length === 0) return;
			removeAwarenessStates(awareness, remoteClientIds, SYNC_ORIGIN);
		},
		dispose() {
			awareness.off('update', handleAwarenessUpdate);
		},
	};

	return {
		controller,
		peers: () => typedAwareness.peers(),
		find(peerId) {
			const all = typedAwareness.peers();
			const sorted = [...all.keys()].sort((a, b) => a - b);
			for (const clientId of sorted) {
				const state = all.get(clientId)!;
				if (state.peer.id === peerId) {
					return { clientId, state };
				}
			}
			return undefined;
		},
		async waitForPeer(peerId, { timeoutMs }) {
			let sawPeers = false;
			const tryMatch = (): ResolvedPeer | undefined => {
				const all = typedAwareness.peers();
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
				return internals.createPeerMiss({
					peerTarget: peerId,
					sawPeers,
					waitMs: timeoutMs,
					emptyReason: internals.describeOfflineReason(internals.status()),
				});
			}

			return new Promise((resolve) => {
				const stop = typedAwareness.observe(() => {
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
						internals.createPeerMiss({
							peerTarget: peerId,
							sawPeers,
							waitMs: timeoutMs,
							emptyReason: internals.describeOfflineReason(internals.status()),
						}),
					);
				}, timeoutMs);
			});
		},
		observe(callback) {
			return (typedAwareness as Awareness<typeof peerPresenceDefs>).observe(
				callback,
			);
		},
		raw: { awareness },
	};
}
