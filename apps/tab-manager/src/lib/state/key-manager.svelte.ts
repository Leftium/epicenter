/**
 * Svelte reactive adapter for the framework-agnostic key manager.
 *
 * This file is the bridge between two independent systems:
 *
 * ```
 * auth.svelte.ts          this file             @epicenter/workspace
 * ┌──────────────┐    ┌────────────────┐    ┌───────────────────┐
 * │ encryptionKey │───▶│ $effect watches │───▶│ createKeyManager   │
 * │ status        │    │ auth state and  │    │ (HKDF, dedup,      │
 * └──────────────┘    │ calls setKey/   │    │  race protection)  │
 * │ lock/wipe       │    └───────────────────┘
 * └────────────────┘
 * ```
 *
 * Neither auth nor the workspace package imports the other—this adapter
 * is the only coupling point. Kept as a separate module so auth stays
 * a pure auth concern and createKeyManager stays framework-agnostic.
 */

import { createKeyManager } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';
import { keyCache } from './key-cache';

const keyManager = createKeyManager(workspaceClient, { keyCache });

/**
 * Start a Svelte `$effect.root` that synchronizes auth state to the
 * workspace encryption lifecycle.
 *
 * Creates an independent reactive scope (not tied to any component's
 * initialization phase) that watches `authState.encryptionKey` and
 * `authState.status`. When auth state changes:
 * - **Key appears** → `setKey()` derives the HKDF workspace key and unlocks
 * - **Signing out** → `wipe()` destroys local encrypted data
 * - **Otherwise** → `lock()` soft-locks (data preserved, writes blocked)
 *
 * Uses `$effect.root` because this is called from `onMount`, which runs
 * after the component's synchronous initialization phase—no implicit
 * component owner exists at that point.
 *
 * @returns Cleanup function that tears down the reactive scope. Call from
 *   `onMount`'s teardown to stop watching auth state on unmount.
 *
 * @example
 * ```typescript
 * // In App.svelte
 * onMount(() => {
 *   const cleanup = syncAuthToEncryption();
 *   return () => cleanup();
 * });
 * ```
 */
export function syncAuthToEncryption() {
	return $effect.root(() => {
		// Fast path: restore cached key before the auth roundtrip completes.
		// Fires once when userId becomes available (storage loads), then the
		// flag prevents re-running. If cache hits, setKey() -> HKDF -> unlock
		// happens in ~1ms instead of waiting 50-200ms for checkSession().
		let cacheRestoreAttempted = false;
		$effect(() => {
			const userId = authState.user?.id;
			if (!userId || cacheRestoreAttempted) return;
			cacheRestoreAttempted = true;
			void keyManager.restoreKey(userId);
		});

		// Main path: react to auth state changes from checkSession() / sign-in / sign-out.
		$effect(() => {
			const key = authState.encryptionKey;
			if (key) {
				keyManager.setKey(key, authState.user?.id);
			} else if (authState.status === 'signing-out') {
				keyManager.wipe();
			} else {
				keyManager.lock();
			}
		});
	});
}
