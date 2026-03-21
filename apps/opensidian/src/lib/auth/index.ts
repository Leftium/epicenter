import { createApps } from '@epicenter/constants/apps';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { ws } from '$lib/workspace';
import { createAuthState } from '@epicenter/svelte/auth-state';

const API_URL = createApps('production').API.URL;

export { tokenStore } from './token-store';
import { tokenStore } from './token-store';

export const authState = createAuthState({
	baseURL: API_URL,
	storagePrefix: 'opensidian',
	tokenStore,
	async onSignedIn(encryptionKey) {
		await ws.activateEncryption(base64ToBytes(encryptionKey));
		ws.extensions.sync.reconnect();
	},
	async onSignedOut() {
		await ws.deactivateEncryption();
		ws.extensions.sync.reconnect();
	},
});
