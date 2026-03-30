/**
 * Honeycrisp workspace client — single Y.Doc instance with IndexedDB
 * persistence, encryption, and WebSocket sync.
 *
 * Access tables via `workspace.tables.folders` / `workspace.tables.notes`
 * and KV settings via `workspace.kv`. The client is ready when
 * `workspace.whenReady` resolves.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { session } from '$lib/auth';
import { userKeyStore } from './user-key-store';
import { honeycrisp } from './schema';


const workspace = createWorkspace(honeycrisp)
	.withEncryption({ userKeyStore })
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${APP_URLS.API}/workspaces/${workspaceId}`,
			getToken: async () => auth.token,
		}),
	);

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.unlockWithKey(session.userKeyBase64);
		workspace.extensions.sync.reconnect();
	},
	onLogout() {
		workspace.clearLocalData();
		workspace.extensions.sync.reconnect();
	},
});

export default workspace;
