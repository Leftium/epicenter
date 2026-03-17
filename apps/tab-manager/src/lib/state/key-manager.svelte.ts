/**
 * Encryption adapter bridging auth lifecycle to the workspace key manager.
 *
 * ```
 * auth.svelte.ts          this file             @epicenter/workspace
 * ┌──────────────┐    ┌────────────────┐    ┌───────────────────┐
 * │ createAuth    │───▶│ encryptionAda- │───▶│ createKeyManager   │
 * │ State(adapter)│    │ pter (module-  │    │ (HKDF, dedup,      │
 * └──────────────┘    │ scope export)  │    │  race protection)  │
 *                     └────────────────┘    └───────────────────┘
 * ```
 *
 * Auth calls the adapter's methods at the right lifecycle moments
 * (sign-in, sign-out, session check, cache restore). This module
 * provides the concrete adapter backed by the workspace key manager.
 *
 * No `$effect`, no reactive observation, no registration functions—
 * just a plain object wired at module scope via constructor injection.
 */

import { createKeyManager } from '@epicenter/workspace/shared/crypto';
import { workspaceClient } from '$lib/workspace';
import { keyCache } from './key-cache';

const keyManager = createKeyManager(workspaceClient, { keyCache });

/**
 * Encryption adapter for auth lifecycle integration.
 *
 * Maps auth lifecycle moments to concrete key manager commands:
 *
 * - **`restoreKeyFromCache(userId)`** → `keyManager.restoreKeyFromCache(userId)` — attempts
 *   instant unlock from the chrome.storage.session cache before the auth
 *   network call completes.
 * - **`setKey(key, userId)`** → `keyManager.setKey(key, userId)` — derives
 *   the HKDF workspace key and unlocks encrypted data.
 * - **`wipe()`** → `keyManager.wipe()` — destroys local encrypted data and
 *   clears the key cache.
 *
 * Passed to `createAuthState()` at module scope in `auth.svelte.ts`.
 * Auth calls these methods directly—no registration, no cleanup needed.
 *
 * @example
 * ```typescript
 * // In auth.svelte.ts
 * import { encryptionAdapter } from './key-manager.svelte';
 *
 * export const authState = createAuthState(encryptionAdapter);
 * ```
 */
export const encryptionAdapter = {
	restoreKeyFromCache: (userId: string) => void keyManager.restoreKeyFromCache(userId),
	setKey: (key: string, userId: string) => keyManager.setKey(key, userId),
	wipe: () => {
		keyManager.wipe();
	},
};
