/**
 * Key manager — connects auth session to workspace lock/unlock.
 *
 * Delegates the hard parts (HKDF derivation, race protection, mode guards)
 * to the framework-agnostic `createKeyManager()` factory. This file
 * is just the Svelte $effect glue.
 *
 * Call `initKeyManager()` once from an $effect.root context (e.g. App.svelte onMount).
 */

import { createKeyManager } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';

const keyManager = createKeyManager(workspaceClient);

/**
 * Initialize the key manager as a root effect.
 *
 * Watches `authState.encryptionKey` and `authState.status` reactively.
 * When the key appears, connects. On sign-out, wipes local data. Otherwise, soft-locks.
 *
 * @returns Cleanup function (call from onMount cleanup)
 */
export function initKeyManager() {
	return $effect.root(() => {
		$effect(() => {
			const key = authState.encryptionKey;
			if (key) {
				keyManager.setKey(key);
			} else if (authState.status === 'signing-out') {
				keyManager.wipe();
			} else {
				keyManager.lock();
			}
		});
	});
}
