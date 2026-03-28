/**
 * Workspace client — browser-specific wiring.
 *
 * IndexedDB persistence + BroadcastChannel sync with cached startup unlock.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import { createAuth } from '@epicenter/svelte/auth';
import { createWorkspace } from '@epicenter/workspace';
import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
import { session } from '$lib/auth';
import { definition } from './schema';
import { userKeyCache } from './user-key-cache';

let lastKeyVersion: number | undefined;

export const workspace = createWorkspace(definition)
	.withEncryption({ userKeyCache })
	.withExtension('persistence', indexeddbPersistence)
	.withExtension('broadcast', broadcastChannelSync);

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
		}
		if (
			prev.status === 'authenticated' &&
			next.status === 'anonymous'
		) {
			workspace.clearLocalData();
		}
	},
});
