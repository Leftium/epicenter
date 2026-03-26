/**
 * Chrome extension `UserKeyCache` backed by WXT storage (`session:` area).
 *
 * Caches the base64-encoded encryption key so the workspace can
 * decrypt immediately on sidebar/popup reopen without a server roundtrip.
 *
 * Uses WXT's `storage.defineItem` with the `session:` area, which wraps
 * `chrome.storage.session` with type-safe access, consistent with how
 * `device-id.ts` and `storage-state.svelte.ts` use WXT storage elsewhere.
 *
 * Session storage is ideal for this because:
 * - Persists across popup/sidebar opens within a browser session
 * - Auto-clears when the browser closes (no stale keys)
 * - Async JSON-backed API (base64 strings store natively, no conversion)
 *
 * Storage key: `'session:epicenter:encryption-key'` — single key, not per-user.
 * Only one user is active at a time, and `workspace.encryption.deactivate()`
 * clears the
 * cache on every sign-out, so per-user scoping would add complexity for no benefit.
 *
 * @see {@link @epicenter/workspace!UserKeyCache} — The interface this implements
 */

import type { UserKeyCache } from '@epicenter/workspace';
import { storage } from '@wxt-dev/storage';

/**
 * WXT storage item for the cached encryption key.
 *
 * Uses the `session:` area to match `chrome.storage.session` semantics—persists
 * across popup/sidebar reopens but clears when the browser closes.
 */
const encryptionKeyItem = storage.defineItem<string | null>(
	'session:epicenter:encryption-key',
	{ fallback: null },
);

/**
 * `UserKeyCache` implementation using WXT storage (`session:` area).
 *
 * Stores and retrieves the base64-encoded encryption key via WXT's typed
 * storage API. The `clear()` method only removes that key—it does not wipe
 * unrelated session storage entries that other parts of the extension might use.
 *
 * @example
 * ```typescript
 * import { userKeyCache } from '$lib/state/key-cache';
 *
 * createWorkspace(definition).withEncryption({ userKeyCache });
 * ```
 */
export const userKeyCache: UserKeyCache = {
	async save(keyBase64) {
		await encryptionKeyItem.setValue(keyBase64);
	},

	async load() {
		return await encryptionKeyItem.getValue();
	},

	async clear() {
		await encryptionKeyItem.removeValue();
	},
};
