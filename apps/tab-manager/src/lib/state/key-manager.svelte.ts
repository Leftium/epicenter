/**
 * Adapter-driven bridge between auth lifecycle and the workspace key manager.
 *
 * This file is the single coupling point between auth state and encryption:
 *
 * ```
 * auth.svelte.ts          this file             @epicenter/workspace
 * ┌──────────────┐    ┌────────────────┐    ┌───────────────────┐
 * │ lifecycle     │───▶│ registers       │───▶│ createKeyManager   │
 * │ adapter slot  │    │ adapter that    │    │ (HKDF, dedup,      │
 * └──────────────┘    │ maps to key     │    │  race protection)  │
 *                     │ manager methods │    └───────────────────┘
 *                     └────────────────┘
 * ```
 *
 * Auth defines a narrow `EncryptionAdapter` interface and calls it at the
 * right moments (sign-in, sign-out, session check, cache restore). This
 * module injects the concrete adapter via `authState.registerEncryption()`.
 *
 * No `$effect`, no reactive observation, no boolean flags—just a plain
 * function that wires imperative calls through to the key manager.
 */

import { createKeyManager } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { authState } from './auth.svelte';
import { keyCache } from './key-cache';

const keyManager = createKeyManager(workspaceClient, { keyCache });

/**
 * Wire auth lifecycle events to the workspace encryption key manager.
 *
 * Registers an `EncryptionAdapter` on `authState` that translates lifecycle
 * calls into key manager commands:
 *
 * - **`restoreKey(userId)`** → `keyManager.restoreKey(userId)` — attempts
 *   instant unlock from the chrome.storage.session cache before the auth
 *   network call completes.
 * - **`setKey(key, userId)`** → `keyManager.setKey(key, userId)` — derives
 *   the HKDF workspace key and unlocks encrypted data.
 * - **`wipe()`** → `keyManager.wipe()` — destroys local encrypted data and
 *   clears the key cache.
 *
 * @returns Cleanup function that unregisters the adapter. Call from
 *   `onMount`'s teardown to prevent stale adapter references.
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
	return authState.registerEncryption({
		restoreKey: (userId) => void keyManager.restoreKey(userId),
		setKey: (key, userId) => keyManager.setKey(key, userId),
		wipe: () => {
			keyManager.wipe();
		},
	});
}
