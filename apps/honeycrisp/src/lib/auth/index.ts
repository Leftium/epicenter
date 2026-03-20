import { createApps } from '@epicenter/constants/apps';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import workspace, { setTokenProvider } from '$lib/workspace/client';
import { createAuthState } from './create-auth-state.svelte';

const API_URL = createApps('production').API.URL;

export const authState = createAuthState({
	baseURL: API_URL,
	storagePrefix: 'honeycrisp',
	async onSignedIn(encryptionKey) {
		// Runtime check: WorkspaceClientBuilder<..., EncryptionMethods> doesn't
		// expose encryption methods on the base WorkspaceClient type (workspace
		// package type bug). The methods exist at runtime after .withEncryption().
		if (encryptionKey && 'activateEncryption' in workspace) {
			const ws = workspace as { activateEncryption(k: Uint8Array): Promise<void> };
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

setTokenProvider(() => authState.token);
