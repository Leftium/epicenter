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
import { userKeyCache } from './user-key-cache';
import { honeycrisp } from './schema';

let lastKeyVersion: number | undefined;

const workspace = createWorkspace(honeycrisp)
	.withEncryption({ userKeyCache })
	.withExtension('persistence', indexeddbPersistence)
	.withExtension(
		'sync',
		createSyncExtension({
			url: (workspaceId) => `${APP_URLS.API}/workspaces/${workspaceId}`,
			getToken: async () =>
				authState.session.status === 'authenticated'
					? authState.session.token
					: null,
		}),
	);

export const authState = createAuth({
	baseURL: APP_URLS.API,
	session,
	onSessionChange(next, prev) {
		if (next.status === 'authenticated') {
			if (next.keyVersion !== lastKeyVersion) {
				authState
					.fetchWorkspaceKey()
					.then(({ userKeyBase64, keyVersion }) => {
						workspace.unlockWithKey(userKeyBase64);
						lastKeyVersion = keyVersion;
					});
			}
			workspace.extensions.sync.reconnect();
		}
		if (
			prev.status === 'authenticated' &&
			next.status === 'anonymous'
		) {
			workspace.clearLocalData();
			workspace.extensions.sync.reconnect();
		}
	},
});

export default workspace;
