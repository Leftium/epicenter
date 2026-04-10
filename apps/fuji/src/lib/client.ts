/**
 * Fuji workspace client — single Y.Doc instance with IndexedDB persistence,
 * encryption, and WebSocket sync (with built-in BroadcastChannel cross-tab sync).
 *
 * Access tables via `workspace.tables.entries` and KV settings via
 * `workspace.kv`. The client is ready when `workspace.whenReady`
 * resolves.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import {
	createSyncExtension,
	toWsUrl,
} from '@epicenter/workspace/extensions/sync/websocket';
import { session } from '$lib/auth';
import { createFujiWorkspace } from '$lib/workspace';

export const workspace = createFujiWorkspace()
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) =>
				toWsUrl(`${APP_URLS.API}/workspaces/${workspaceId}`),
			getToken: async () => auth.token,
		}),
	);

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.applyEncryptionKeys(session.encryptionKeys);
		workspace.extensions.sync.reconnect();
	},
	onLogout() {
		workspace.clearLocalData();
		workspace.extensions.sync.reconnect();
	},
});
