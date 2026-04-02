/**
 * Chrome extension `UserKeyStore` backed by WXT storage (`session:` area).
 *
 * Caches encryption keys so the workspace can unlock immediately on
 * sidebar/popup reopen without a server roundtrip. Serialization is
 * handled internally: `set()` JSON-stringifies, `get()` parses and
 * validates with the ArkType `EncryptionKeys` schema.
 *
 * Uses WXT's `storage.defineItem` with the `session:` area, which wraps
 * `chrome.storage.session` with type-safe access, consistent with how
 * `device-id.ts` and `storage-state.svelte.ts` use WXT storage elsewhere.
 *
 * Session storage is ideal for this because:
 * - Persists across popup/sidebar opens within a browser session
 * - Auto-clears when the browser closes (no stale keys)
 * - Async JSON-backed API (JSON strings store natively)
 *
 * Storage key: `'session:epicenter:encryption-key'` — single key, not per-user.
 * Only one user is active at a time, and `workspace.clearLocalData()`
 * clears the cache on every sign-out, so per-user scoping would add
 * complexity for no benefit.
 *
 * @see {@link @epicenter/workspace!UserKeyStore} — The interface this implements
 */

import type { UserKeyStore } from '@epicenter/workspace';
import { EncryptionKeys } from '@epicenter/workspace';
import { storage } from '@wxt-dev/storage';
import { type } from 'arktype';

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
 * `UserKeyStore` implementation using WXT storage (`session:` area).
 *
 * Stores encryption keys as a JSON string via WXT's typed storage API.
 * On `get()`, deserializes and validates with the ArkType `EncryptionKeys`
 * schema—returns `null` on any failure (missing, corrupt, schema mismatch).
 * The `delete()` method only removes the encryption-key entry—it does not
 * wipe unrelated session storage entries that other parts of the extension
 * might use.
 *
 * @example
 * ```typescript
 * import { userKeyStore } from '$lib/state/key-store';
 *
 * createWorkspace(definition).withEncryption({ userKeyStore });
 * ```
 */
export const userKeyStore: UserKeyStore = {
	async set(keys) {
		await encryptionKeyItem.setValue(JSON.stringify(keys));
	},

	async get() {
		const raw = await encryptionKeyItem.getValue();
		if (!raw) return null;

		try {
			const parsed = JSON.parse(raw);
			const result = EncryptionKeys(parsed);
			if (result instanceof type.errors) {
				console.error(
					'[key-store] Cached encryption keys invalid:',
					result.summary,
				);
				return null;
			}
			return result;
		} catch (error) {
			console.error(
				'[key-store] Failed to parse cached encryption keys:',
				error,
			);
			return null;
		}
	},

	async delete() {
		await encryptionKeyItem.removeValue();
	},
};
