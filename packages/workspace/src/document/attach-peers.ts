import * as Y from 'yjs';
import { actionManifest } from '../shared/action-manifest.js';
import type { Actions } from '../shared/actions.js';
import {
	type Awareness,
	type AwarenessState,
	attachAwareness,
} from './attach-awareness.js';
import {
	type DeviceDescriptor,
	type PeerDevice,
	standardAwarenessDefs,
} from './standard-awareness-defs.js';

/**
 * Per-peer awareness state under the `standardAwarenessDefs` schema.
 * Every field is required: `attachPeers` publishes synchronously at attach
 * time, so any state on the wire (local or remote) carries `device` in full.
 */
export type PeerAwarenessState = AwarenessState<typeof standardAwarenessDefs>;

export type FoundPeer = {
	clientId: number;
	state: PeerAwarenessState;
};

/**
 * Returned by `attachPeers`. Owns an awareness instance scoped to the
 * standard `device` schema and exposes peer-shaped lookup helpers.
 *
 * `awareness` is the escape hatch — pass `awareness.raw` to `attachSync`,
 * or `setLocal` / `setLocalField` on it to mutate the published device
 * after attach time.
 */
export type Peers = {
	awareness: Awareness<typeof standardAwarenessDefs>;
	/** Snapshot of every connected peer (excludes self). */
	list(): Map<number, PeerAwarenessState>;
	/** First peer publishing `deviceId`, by ascending clientId. */
	find(deviceId: string): FoundPeer | undefined;
	/** Subscribe to peer change events. Returns an unsubscribe function. */
	observe(callback: () => void): () => void;
};

/**
 * Doc shape `attachPeers` requires — the workspace bundle's `ydoc` plus its
 * `actions` tree. Structural so any factory return value satisfies it.
 */
export type DocWithActions = {
	ydoc: Y.Doc;
	actions: Actions;
};

/**
 * Workspace-doc preset for cross-device peer discovery.
 *
 * Owns the `standardAwarenessDefs` schema and the `actionManifest(actions)`
 * derivation, so app code never types either of them. The published device
 * carries `{ id, name, platform, offers }` from the first frame.
 *
 * Pair with `attachSync` for transport: `attachSync(doc.ydoc, { awareness:
 * peers.awareness.raw, actions: doc.actions, ... })`.
 *
 * For workspace docs that need extra presence fields (typing, viewing),
 * drop to `attachAwareness` directly with a custom schema. Cursors and
 * editing presence belong on content docs, not workspace docs — they get
 * their own preset when they land.
 */
export function attachPeers<TDoc extends DocWithActions>(
	doc: TDoc,
	{ device }: { device: DeviceDescriptor },
): Peers {
	const awareness = attachAwareness(doc.ydoc, standardAwarenessDefs, {
		device: {
			...device,
			offers: actionManifest(doc.actions),
		} satisfies PeerDevice,
	});

	return {
		awareness,
		list: () => awareness.peers(),
		find(deviceId) {
			const all = awareness.peers();
			const sorted = [...all.keys()].sort((a, b) => a - b);
			for (const clientId of sorted) {
				const state = all.get(clientId)!;
				if (state.device.id === deviceId) {
					return { clientId, state };
				}
			}
			return undefined;
		},
		observe: (callback) => awareness.observe(callback),
	};
}
