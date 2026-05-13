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
	openCollaboration,
	type PeerIdentity,
	toWsUrl,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import { createTabManagerActions } from '$lib/workspace/actions';
import type { DeviceId } from '$lib/workspace/definition';

import { openTabManagerDoc } from './index';

type TabManagerPeer = PeerIdentity & { id: DeviceId };

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
	const identity = await Promise.resolve(peer);

	const doc = openTabManagerDoc({ encryptionKeys });
	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	const actions = createTabManagerActions({
		tables: doc.tables,
		batch: doc.batch,
		deviceId: Promise.resolve(identity.id),
	});

	const collaboration = openCollaboration(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb.whenLoaded,
		openWebSocket,
		identity,
		actions,
	});

	return {
		ydoc: doc.ydoc,
		tables: doc.tables,
		kv: doc.kv,
		batch: doc.batch,
		idb,
		collaboration,
		async wipe() {
			doc[Symbol.dispose]();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [doc.ydoc.guid],
			});
		},
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}
