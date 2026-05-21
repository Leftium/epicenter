/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here.
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	type Collaboration,
	type LocalOwner,
	type OpenWebSocket,
	openCollaboration,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import { createTabManagerActions } from '$lib/workspace/actions';
import { type DeviceId, tabManagerTables } from '$lib/workspace/definition';
import { tabManagerSyncUrl } from './sync-url.js';

/**
 * Build the tab-manager binding. Synchronous: callers must resolve the
 * installation id before invoking (the extension's installation id comes from
 * `chrome.storage.local` via `createDeviceProfile()` in `device.ts`).
 *
 * Consumers gate UI render on `tabManager.idb.whenLoaded`; Cloud sync is
 * independent and connects whenever a Workspace route is available.
 */
export function openTabManagerBrowser({
	owner,
	installationId,
}: {
	owner: LocalOwner;
	installationId: DeviceId;
}) {
	const ydoc = new Y.Doc({ guid: 'epicenter.tab-manager', gc: true });
	const encryption = owner.attachEncryption(ydoc);
	const tables = encryption.attachTables(tabManagerTables);
	const kv = encryption.attachKv({});
	const batch = (fn: () => void) => ydoc.transact(fn);

	const idb = owner.attachLocal(ydoc);

	const actions = createTabManagerActions({
		tables,
		batch,
		deviceId: Promise.resolve(installationId),
	});

	return {
		installationId,
		ydoc,
		tables,
		kv,
		batch,
		idb,
		actions,
		async wipe() {
			ydoc.destroy();
			await idb.whenDisposed;
			await owner.wipeLocalYjsData([ydoc.guid]);
		},
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type TabManagerBrowser = ReturnType<typeof openTabManagerBrowser>;

export function openTabManagerCloudCollaboration({
	tabManager,
	openWebSocket,
	defaultWorkspaceId,
}: {
	tabManager: TabManagerBrowser;
	openWebSocket?: OpenWebSocket;
	defaultWorkspaceId?: string;
}): Collaboration<TabManagerBrowser['actions']> | undefined {
	const syncUrl = tabManagerSyncUrl({
		apiUrl: APP_URLS.API,
		defaultWorkspaceId,
	});
	if (!syncUrl) return undefined;
	return openCollaboration(tabManager.ydoc, {
		url: syncUrl,
		waitFor: tabManager.idb.whenLoaded,
		openWebSocket,
		installationId: tabManager.installationId,
		actions: tabManager.actions,
	});
}
