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

import { openTabManagerDocument } from './document.js';

type TabManagerPeer = PeerIdentity & { id: DeviceId };

/**
 * Build the tab-manager binding. Synchronous: callers must resolve the
 * peer identity before invoking (the extension's identity comes from
 * `chrome.storage.local` and from `createPeer()` in `device.ts`).
 *
 * Consumers gate UI render on `tabManager.idb.whenLoaded`; sync (the
 * WebSocket) is independent and connects whenever the network allows.
 */
export function openTabManagerBrowser({
	userId,
	peer,
	openWebSocket,
	encryptionKeys,
}: {
	userId: string;
	peer: TabManagerPeer;
	openWebSocket?: OpenWebSocket;
	encryptionKeys: () => EncryptionKeys;
}) {
	const doc = openTabManagerDocument({ encryptionKeys });
	const idb = doc.encryption.attachIndexedDb(doc.ydoc, { userId });
	attachOwnedBroadcastChannel(doc.ydoc, { userId });

	const actions = createTabManagerActions({
		tables: doc.tables,
		batch: doc.batch,
		deviceId: Promise.resolve(peer.id),
	});

	const collaboration = openCollaboration(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb.whenLoaded,
		openWebSocket,
		identity: peer,
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
