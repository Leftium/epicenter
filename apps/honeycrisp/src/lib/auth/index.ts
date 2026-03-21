import { createApps } from '@epicenter/constants/apps';
import { createAuthState } from '@epicenter/svelte/auth-state';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import workspace from '$lib/workspace';

const API_URL = createApps('production').API.URL;

export { tokenStore } from './token-store';

import { tokenStore } from './token-store';

export const authState = createAuthState({
	baseURL: API_URL,
	storagePrefix: 'honeycrisp',
	tokenStore,
	async onSignedIn(encryptionKey) {
		await workspace.activateEncryption(base64ToBytes(encryptionKey));
		workspace.extensions.sync.reconnect();
	},
	async onSignedOut() {
		await workspace.deactivateEncryption();
		workspace.extensions.sync.reconnect();
	},
});
