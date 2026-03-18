/**
 * Chrome extension `KeyCache` backed by `chrome.storage.session`.
 *
 * Caches the base64-encoded encryption key so the workspace can
 * decrypt immediately on sidebar/popup reopen without a server roundtrip.
 *
 * `chrome.storage.session` is ideal for this because:
 * - Persists across popup/sidebar opens within a browser session
 * - Auto-clears when the browser closes (no stale keys)
 * - Async JSON-backed API (base64 strings store natively, no conversion)
 *
 * Storage key: `'epicenter:encryption-key'` — single key, not per-user. Only one
 * user is active at a time, and `deactivateEncryption()` clears the cache on
 * every sign-out, so per-user scoping would add complexity for no benefit.
 *
 * @see {@link @epicenter/workspace/shared/crypto/key-cache} — The interface this implements
 */

import type { KeyCache } from '@epicenter/workspace/shared/crypto/key-cache';

/**
 * Session storage key for the cached encryption key.
 *
 * Prefixed with `epicenter:` to avoid collisions with other extensions or
 * libraries sharing `chrome.storage.session`. A single key (not per-user)
 * because `deactivateEncryption()` always clears the cache on sign-out—there's
 * only ever one active user's key stored at a time.
 */
const STORAGE_KEY = 'epicenter:encryption-key';

/**
 * `KeyCache` implementation using `chrome.storage.session`.
 *
 * Stores and retrieves the base64-encoded encryption key under a single
 * storage key (`epicenter:encryption-key`). The `clear()` method only removes
 * that key—it does not wipe unrelated session storage entries that other parts
 * of the extension might use.
 *
 * @example
 * ```typescript
 * import { keyCache } from '$lib/state/key-cache';
 *
 * // Used as hooks for workspace encryption
 * createWorkspace(definition).withEncryption({
 *   onActivate: (userKey) => keyCache.save(bytesToBase64(userKey)),
 *   onDeactivate: () => keyCache.clear(),
 * });
 * ```
 */
export const keyCache: KeyCache = {
	async save(keyBase64) {
		await browser.storage.session.set({ [STORAGE_KEY]: keyBase64 });
	},

	async load() {
		const result = await browser.storage.session.get(STORAGE_KEY);
		return result[STORAGE_KEY] as string | undefined;
	},

	async clear() {
		await browser.storage.session.remove(STORAGE_KEY);
	},
};
