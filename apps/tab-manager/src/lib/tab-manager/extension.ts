/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here.
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachEncryption,
	attachOwnedBroadcastChannel,
	type EncryptionKeys,
	type OpenWebSocket,
	openCollaboration,
	type Replica,
	websocketUrl,
	wipeOwnerLocalYjsData,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createTabManagerActions } from '$lib/workspace/actions';
import {
	type DeviceId,
	tabManagerTables,
} from '$lib/workspace/definition';

type TabManagerReplica = Replica & { id: DeviceId };

/**
 * Build the tab-manager binding. Synchronous: callers must resolve the
 * replica descriptor before invoking (the extension's replica id comes from
 * `chrome.storage.local` and from `createDeviceProfile()` in `device.ts`).
 *
 * Consumers gate UI render on `tabManager.idb.whenLoaded`; sync (the
 * WebSocket) is independent and connects whenever the network allows.
 */
export function openTabManagerBrowser({
	userId,
	replica,
	openWebSocket,
	encryptionKeys,
}: {
	userId: string;
	replica: TabManagerReplica;
	openWebSocket?: OpenWebSocket;
	encryptionKeys: () => EncryptionKeys;
}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager', gc: false });
	const encryption = attachEncryption(ydoc, { encryptionKeys });
	const tables = encryption.attachTables(tabManagerTables);
	const kv = encryption.attachKv({});
	const batch = (fn: () => void) => ydoc.transact(fn);

	const idb = encryption.attachIndexedDb(ydoc, { userId });
	attachOwnedBroadcastChannel(ydoc, { userId });

	const actions = createTabManagerActions({
		tables,
		batch,
		deviceId: Promise.resolve(replica.id),
	});

	const collaboration = openCollaboration(ydoc, {
		url: websocketUrl(`${APP_URLS.API}/workspaces/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
		openWebSocket,
		replica,
		actions,
	});

	return {
		ydoc,
		tables,
		kv,
		batch,
		idb,
		collaboration,
		async wipe() {
			ydoc.destroy();
			await Promise.all([idb.whenDisposed, collaboration.whenDisposed]);
			await wipeOwnerLocalYjsData({
				userId,
				ydocGuids: [ydoc.guid],
			});
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type TabManagerBrowser = ReturnType<typeof openTabManagerBrowser>;
