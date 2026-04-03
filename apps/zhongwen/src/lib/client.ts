/**
 * Workspace client — browser-specific wiring.
 *
 * IndexedDB persistence + BroadcastChannel sync with cached startup unlock.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createIndexedDbKeyStore } from '@epicenter/svelte';
import { createAuth } from '@epicenter/svelte/auth';
import { createWorkspace } from '@epicenter/workspace';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { session } from '$lib/auth';
import { definition } from './workspace/definition';
export const workspace = createWorkspace(definition)
	.withEncryption({
		userKeyStore: createIndexedDbKeyStore('zhongwen:encryption-key'),
	})
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync);

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.unlockWithKeys(session.encryptionKeys);
	},
	onLogout() {
		workspace.clearLocalData();
	},
});
