/**
 * Opensidian auth state singleton.
 *
 * Wires the shared auth factory with opensidian-specific adapters:
 * - localStorage for token/user persistence
 * - Workspace encryption + sync reconnect on sign-in/out
 *
 * Import `authState` anywhere in the app for reactive auth status,
 * user info, and sign-in/out actions.
 *
 * @example
 * ```typescript
 * import { authState } from '$lib/auth';
 *
 * // Reactive reads
 * authState.status  // 'checking' | 'signed-in' | 'signed-out' | ...
 * authState.user    // AuthUser | undefined
 *
 * // Actions with explicit params
 * await authState.signIn({ email, password });
 * await authState.signOut();
 * ```
 */

import { createApps } from '@epicenter/constants/apps';
import { base64ToBytes } from '@epicenter/workspace/shared/crypto';
import { type } from 'arktype';
import { ws } from '$lib/workspace';
import { createAuthState } from './create-auth-state.svelte';
import { createLocalStorageAdapter } from './local-storage-adapter.svelte';
import { AuthUser } from './types';

const API_URL = createApps('production').API.URL;

export const authState = createAuthState({
	baseURL: API_URL,
	tokenStorage: createLocalStorageAdapter({
		key: 'opensidian:authToken',
		schema: type('string').or('undefined'),
		fallback: undefined,
	}),
	userStorage: createLocalStorageAdapter({
		key: 'opensidian:authUser',
		schema: AuthUser.or('undefined'),
		fallback: undefined,
	}),
	async onSignedIn(encryptionKey) {
		if (encryptionKey && 'activateEncryption' in ws) {
			const encryptedWs = ws as {
				activateEncryption(key: Uint8Array): Promise<void>;
			};
			await encryptedWs.activateEncryption(base64ToBytes(encryptionKey));
		}
		ws.extensions.sync.reconnect();
	},
	async onSignedOut() {
		if ('deactivateEncryption' in ws) {
			const encryptedWs = ws as { deactivateEncryption(): Promise<void> };
			await encryptedWs.deactivateEncryption();
		}
		ws.extensions.sync.reconnect();
	},
});
