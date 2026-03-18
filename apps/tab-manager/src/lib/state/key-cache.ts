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
 * Storage key: `'ek'` — single key, one active encryption key per workspace.
 *
 * @see {@link @epicenter/workspace/shared/crypto/key-cache} — The interface this implements
 */

import type { KeyCache } from '@epicenter/workspace/shared/crypto/key-cache';

const STORAGE_KEY = 'ek';

/**
 * `KeyCache` implementation using `chrome.storage.session`.
 *
 * Stores and retrieves the base64-encoded encryption key under a single
 * storage key. The `clear()` method only removes the `ek` key—it does not
 * wipe unrelated session storage entries that other parts of the extension
 * might use.
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
