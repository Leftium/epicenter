/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here.
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import type { AuthIdentity } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachOwnedBroadcastChannel,
	attachSync,
	createRemoteClient,
	PeerIdentity,
	toWsUrl,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import type { DeviceId } from '$lib/workspace/definition';

type TabManagerPeer = PeerIdentity & { id: DeviceId };

import { openTabManager as openTabManagerDoc } from './index';

/**
 * Construction is async because awareness publishes the peer identity
 * synchronously at attach time (no two-step "online but no device yet"
 * window). Awaiting the identity up front means every peer sees a
 * well-formed `state.peer` from the first frame.
 *
 * `idb.whenLoaded` still gates UI render on idb hydration; sync (the
 * WebSocket) is independent and connects whenever the network allows.
 */
export async function openTabManager({
	identity,
	peer,
	bearerToken,
}: {
	identity: AuthIdentity;
	peer: TabManagerPeer | Promise<TabManagerPeer>;
	bearerToken?: () => string | null;
}) {
	const resolvedPeer = await Promise.resolve(peer);
	const userId = identity.user.id;

	const doc = openTabManagerDoc({
		deviceId: Promise.resolve(resolvedPeer.id),
		encryptionKeys: identity.encryptionKeys,
	});

	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer: resolvedPeer },
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		bearerToken,
		awareness,
	});
	const rpc = sync.attachRpc(doc.actions);
	const remote = createRemoteClient({ awareness, rpc });

	return {
		...doc,
		idb,
		awareness,
		sync,
		async wipe() {
			doc[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, sync.whenDisposed]);
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [doc.ydoc.guid],
			});
		},
		remote,
		rpc,
		peer: resolvedPeer,
		device: resolvedPeer,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}
