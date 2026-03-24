import { APP_URLS } from '@epicenter/constants/vite';
import {
	createAuthState,
	createLocalStorage,
	googleRedirect,
} from '@epicenter/svelte/auth-state';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import workspace from '$lib/workspace';

export const authState = createAuthState({
	baseURL: APP_URLS.API,
	storage: createLocalStorage('honeycrisp'),
	strategies: { signInWithGoogle: googleRedirect },
	async onSignedIn(encryptionKey) {
		await workspace.activateEncryption(base64ToBytes(encryptionKey));
		workspace.extensions.sync.reconnect();
	},
	async onSignedOut() {
		await workspace.deactivateEncryption();
		workspace.extensions.sync.reconnect();
	},
});
