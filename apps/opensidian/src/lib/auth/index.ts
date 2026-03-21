import { createApps } from '@epicenter/constants/apps';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { ws } from '$lib/workspace';
import { createAuthState } from './create-auth-state.svelte';

const API_URL = createApps('production').API.URL;

export const authState = createAuthState({
	baseURL: API_URL,
	storagePrefix: 'opensidian',
	async onSignedIn(encryptionKey) {
		// Runtime check: workspace package type bug—EncryptionMethods not
		// surfaced on WorkspaceClient base type. Methods exist at runtime.
		if (encryptionKey && 'activateEncryption' in ws) {
			const encrypted = ws as { activateEncryption(k: Uint8Array): Promise<void> };
			await encrypted.activateEncryption(base64ToBytes(encryptionKey));
		}
		ws.extensions.sync.reconnect();
	},
	async onSignedOut() {
		if ('deactivateEncryption' in ws) {
			const encrypted = ws as { deactivateEncryption(): Promise<void> };
			await encrypted.deactivateEncryption();
		}
		ws.extensions.sync.reconnect();
	},
});
