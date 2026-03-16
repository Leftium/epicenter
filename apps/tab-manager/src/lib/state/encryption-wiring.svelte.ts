/**
 * Encryption wiring — connects auth session to workspace lock/unlock.
 *
 * Delegates the hard parts (HKDF derivation, race protection, mode guards)
 * to the framework-agnostic `createEncryptionWiring()` factory. This file
 * is just the Svelte $effect glue.
 *
 * Call `initEncryptionWiring()` once from an $effect.root context (e.g. App.svelte onMount).
 */

import {
	base64ToBytes,
	createEncryptionWiring,
} from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';

const wiring = createEncryptionWiring(workspaceClient);

/**
 * Initialize the encryption wiring as a root effect.
 *
 * Watches `authState.encryptionKey` and `authState.status` reactively.
 * When the key changes, calls `wiring.connect()` or `wiring.disconnect()`.
 *
 * @returns Cleanup function (call from onMount cleanup)
 */
export function initEncryptionWiring() {
	return $effect.root(() => {
		$effect(() => {
			const key = authState.encryptionKey;
			if (key) {
				wiring.connect(base64ToBytes(key));
			} else {
				wiring.disconnect({ wipe: authState.status === 'signing-out' });
			}
		});
	});
}
