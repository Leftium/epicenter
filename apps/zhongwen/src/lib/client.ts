/**
 * Workspace client — browser-specific wiring.
 *
 * IndexedDB persistence + BroadcastChannel sync with cached startup unlock.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth';
import { createWorkspace } from '@epicenter/workspace';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
import { session } from '$lib/auth';
import { definition } from './workspace/definition';

export const workspace = createWorkspace(definition)
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync);

// Boot: apply cached encryption keys (sync — localStorage is immediate).
const cached = session.get();
if (cached?.encryptionKeys) {
	workspace.applyEncryptionKeys(cached.encryptionKeys);
}

export const auth = createAuth({
	baseURL: APP_URLS.API,
	session,
	onLogin(session) {
		workspace.applyEncryptionKeys(session.encryptionKeys);
	},
	onLogout() {
		workspace.clearLocalData();
	},
});
