/**
 * Encryption wiring — connects auth session to workspace lock/unlock.
 *
 * When the session provides an encryptionKey (base64), this module:
 * 1. Decodes the per-user key from base64
 * 2. Derives a per-workspace key via HKDF
 * 3. Calls workspaceClient.unlock(wsKey)
 *
 * On sign-out (encryptionKey cleared), calls workspaceClient.lock().
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
 * Watches `authState.encryptionKey` reactively. When it changes:
 * - Non-null → decode, derive workspace key, unlock
 * - Null → lock (if previously unlocked)
 *
 * @returns Cleanup function (call from onMount cleanup)
 */
export function initEncryptionWiring() {
	return $effect.root(() => {
		$effect(() => {
			const keyBase64 = authState.encryptionKey;

			if (keyBase64) {
				const userKey = base64ToBytes(keyBase64);
				// Derive per-workspace key and unlock — async but fire-and-forget
				// (workspace stays in current mode until the key is ready)
				void deriveWorkspaceKey(userKey, workspaceClient.id).then((wsKey) => {
					workspaceClient.unlock(wsKey);
				});
			} else if (workspaceClient.mode === 'unlocked') {
				workspaceClient.lock();
			}
		});
	});
}
