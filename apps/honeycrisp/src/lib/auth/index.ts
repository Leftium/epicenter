import { createApps } from '@epicenter/constants/apps';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import workspace from '$lib/workspace';
import { createAuthState } from './create-auth-state.svelte';

const API_URL = createApps('production').API.URL;

export const authState = createAuthState({
	baseURL: API_URL,
	storagePrefix: 'honeycrisp',
	async onSignedIn(encryptionKey) {
		if (encryptionKey && 'activateEncryption' in workspace) {
			const ws = workspace as {
				activateEncryption(key: Uint8Array): Promise<void>;
			};
			await ws.activateEncryption(base64ToBytes(encryptionKey));
		}
		workspace.extensions.sync.reconnect();
	},
	async onSignedOut() {
		if ('deactivateEncryption' in workspace) {
			const ws = workspace as { deactivateEncryption(): Promise<void> };
			await ws.deactivateEncryption();
		}
		workspace.extensions.sync.reconnect();
	},
});
