/**
 * Encryption wiring — connects auth session to workspace lock/unlock.
 *
 * When the session provides an encryptionKey (base64), this module:
 * 1. Decodes the per-user key from base64
 * 2. Derives a per-workspace key via HKDF
 * 3. Calls workspaceClient.unlock(wsKey)
 *
 * On sign-out (encryptionKey cleared + status 'signing-out'), wipes local
 * data via clearLocalData(). On other key-clearing scenarios (session expiry,
 * visibility change), soft-locks instead.
 *
 * Call `initEncryptionWiring()` once from an $effect.root context (e.g. App.svelte onMount).
 */

import {
	base64ToBytes,
	deriveWorkspaceKey,
} from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';

/**
 * Initialize the encryption wiring as a root effect.
 *
 * Watches `authState.encryptionKey` and `authState.status` reactively.
 * When the key changes:
 * - Non-null → decode, derive workspace key, unlock
 * - Null + signing out → clearLocalData (wipe IndexedDB, keep client alive)
 * - Null + other reason → lock (soft, data preserved)
 *
 * @returns Cleanup function (call from onMount cleanup)
 */
export function initEncryptionWiring() {
	return $effect.root(() => {
		$effect(() => {
			const keyBase64 = authState.encryptionKey;
			const status = authState.status;

			if (keyBase64) {
				const userKey = base64ToBytes(keyBase64);
				// Derive per-workspace key and unlock — async but fire-and-forget
				// (workspace stays in current mode until the key is ready)
				void deriveWorkspaceKey(userKey, workspaceClient.id).then((wsKey) => {
					workspaceClient.unlock(wsKey);
				});
			} else if (workspaceClient.mode === 'unlocked') {
				if (status === 'signing-out') {
					// Sign-out — wipe persisted data, keep client alive for next sign-in
					void workspaceClient.clearLocalData();
				} else {
					// Key cleared for other reason (session expiry, etc.) — soft lock
					workspaceClient.lock();
				}
			}
		});
	});
}
