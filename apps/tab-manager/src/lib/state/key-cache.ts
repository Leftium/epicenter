/**
 * Chrome extension `KeyCache` backed by `chrome.storage.session`.
 *
 * Caches the user’s base64-encoded encryption key so the workspace can
 * decrypt immediately on sidebar/popup reopen without a server roundtrip.
 *
 * `chrome.storage.session` is ideal for this because:
 * - Persists across popup/sidebar opens within a browser session
 * - Auto-clears when the browser closes (no stale keys)
 * - Async JSON-backed API (base64 strings store natively, no conversion)
 *
 * Storage key format: `ek:{userId}` — scoped per-user to prevent stale
 * key issues when switching accounts.
 *
 * @see {@link @epicenter/workspace/shared/crypto/key-cache} — The interface this implements
 */

import type { KeyCache } from '@epicenter/workspace/shared/crypto';

const KEY_PREFIX = 'ek:';

/**
 * `KeyCache` implementation using `chrome.storage.session`.
 *
 * Stores and retrieves base64-encoded encryption keys. The `clear()` method
 * only removes `ek:*` keys—it does not wipe unrelated session storage entries
 * that other parts of the extension might use.
 *
 * @example
 * ```typescript
 * import { keyCache } from '$lib/state/key-cache';
 * import { createKeyManager } from '@epicenter/workspace/shared/crypto';
 *
 * const keyManager = createKeyManager(workspace.current, { keyCache });
 * ```
 */
export const keyCache: KeyCache = {
	async set(userId, keyBase64) {
		await browser.storage.session.set({ [`${KEY_PREFIX}${userId}`]: keyBase64 });
	},

	async get(userId) {
		const key = `${KEY_PREFIX}${userId}`;
		const result = await browser.storage.session.get(key);
		return result[key] as string | undefined;
	},

	async clear() {
		const all = await browser.storage.session.get(null);
		const ekKeys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
		if (ekKeys.length > 0) {
			await browser.storage.session.remove(ekKeys);
		}
	},
};
