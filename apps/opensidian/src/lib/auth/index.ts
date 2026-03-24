import { APP_URLS } from '@epicenter/constants/vite';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { ws } from '$lib/workspace';
import { createAuthState, createLocalStorage } from '@epicenter/svelte/auth-state';

export const authState = createAuthState({
	baseURL: APP_URLS.API,
	storage: createLocalStorage('opensidian'),
	async onSignedIn(encryptionKey) {
		await ws.activateEncryption(base64ToBytes(encryptionKey));
		ws.extensions.sync.reconnect();
	},
	async onSignedOut() {
		await ws.deactivateEncryption();
		ws.extensions.sync.reconnect();
	},
});
