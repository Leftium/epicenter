/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here.
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachOwnedBroadcastChannel,
	type EncryptionKeys,
	type OpenWebSocket,
	openWorkspace,
	type PeerIdentity,
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
 * well-formed `identity` field from the first frame.
 *
 * Consumers gate UI render on `tabManager.idb.whenLoaded`; sync (the
 * WebSocket) is independent and connects whenever the network allows.
 */
export async function openTabManager({
	userId,
	peer,
	openWebSocket,
	encryptionKeys,
}: {
	userId: string;
	peer: TabManagerPeer | Promise<TabManagerPeer>;
	openWebSocket?: OpenWebSocket;
	encryptionKeys: () => EncryptionKeys;
}) {
	const resolvedPeer = await Promise.resolve(peer);

	const doc = openTabManagerDoc({
		deviceId: Promise.resolve(resolvedPeer.id),
		encryptionKeys,
	});

	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	const workspace = openWorkspace(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb.whenLoaded,
		openWebSocket,
		identity: resolvedPeer,
		actions: doc.actions,
	});

	return {
		...doc,
		idb,
		workspace,
		async wipe() {
			doc[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, workspace.whenDisposed]);
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [doc.ydoc.guid],
			});
		},
		peer: resolvedPeer,
		device: resolvedPeer,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}
