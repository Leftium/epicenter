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

/**
 * Returned by `attachPeers`. Owns an awareness instance scoped to the
 * standard `device` schema and exposes typed lookup helpers.
 *
 * `awareness` is the escape hatch — pass `awareness.raw` to `attachSync`,
 * or use `setLocal` / `setLocalField` to mutate the published device.
 */
export type Peers = {
	awareness: Awareness<typeof standardAwarenessDefs>;
	peers(): Map<number, PeerAwarenessState>;
	findPeer(deviceId: string): { clientId: number; state: PeerAwarenessState } | undefined;
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
 * carries `{ id, name, platform, offers }` from the first frame; consumers
 * read peers via `peers()` or resolve a specific peer with `findPeer(id)`.
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
		peers: () => awareness.peers(),
		findPeer(deviceId) {
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
	};
}
