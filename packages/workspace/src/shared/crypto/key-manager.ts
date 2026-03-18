/**
 * Framework-agnostic key manager factory.
 *
 * Bridges the async gap between auth sessions (which provide an encryption key)
 * and the workspace client (which needs a derived key to unlock). Handles
 * HKDF derivation, race protection via a generation counter, and optional key
 * caching—so per-app reactive glue is ~5 lines instead of 50+.
 *
 * This factory is deliberately framework-agnostic. Each app provides a thin
 * reactive adapter (Svelte `$effect`, React `useEffect`, etc.) that watches
 * its auth state and calls the imperative `unlock`/`wipe` API:
 *
 * ```
 * ┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
 * │ Auth State   │────▶│ Reactive Adapter  │────▶│ Key Manager     │
 * │ (per-app)    │     │ (~5 lines glue)   │     │ (this factory)  │
 * └─────────────┘     └──────────────────┘     └─────────────────┘
 * ```
 *
 * @example
 * ```typescript
 * import { createKeyManager } from '@epicenter/workspace/shared/crypto';
 *
 * const keyManager = createKeyManager(workspaceClient);
 *
 * // Svelte adapter (~5 lines of $effect glue in a .svelte.ts file):
 * $effect.root(() => {
 *   $effect(() => {
 *     const key = authState.encryptionKey;
 *     if (key) keyManager.unlock(key);
 *     else if (authState.status === 'signing-out') keyManager.wipe();
 *   });
 * });
 * ```
 *
 * @module
 */

import { base64ToBytes, deriveWorkspaceKey } from './index';
import type { KeyCache } from './key-cache';

/**
 * Minimal client surface the key manager needs to drive unlock/wipe.
 *
 * Intentionally narrow—only the methods the key manager actually calls.
 * The key manager never reads encryption state (none/active); encryption state
 * guarding is the client's responsibility. Any workspace client that
 * implements these members can be managed.
 */
export type KeyManagerTarget = {
	readonly id: string;
	unlock(key: Uint8Array): void;
	clearLocalData(): Promise<void>;
};

/**
 * Configuration for the key manager factory.
 *
 * @example
 * ```typescript
 * const keyManager = createKeyManager(workspaceClient, {
 *   keyCache: createIndexedDbKeyCache('encryption-keys'),
 * });
 * ```
 */
export type KeyManagerConfig = {
	/** Optional key cache for instant unlock on page refresh. */
	keyCache?: KeyCache;
};

/**
 * Imperative unlock/wipe API for encryption lifecycle management.
 *
 * The factory owns the hard parts—async HKDF bridging, duplicate key dedup,
 * and race protection. The consumer just pushes key presence/absence from
 * their framework's reactive system.
 *
 * Encryption state guarding (none/active) is the client's job—the key
 * manager always calls through regardless of encryption state.
 */
export type KeyManager = {
	/**
	 * Unlock using a user-level encryption key (base64-encoded).
	 *
	 * Decodes base64 → derives per-workspace key via HKDF → calls `unlock()`.
	 * No-op if called with the same key as the previous `unlock()`, so reactive
	 * systems can call this on every tick without triggering redundant derivations.
	 *
	 * If a `keyCache` was provided, caches the base64 key under `userId`
	 * for instant unlock on subsequent page loads.
	 *
	 * @param userKeyBase64 - Base64-encoded user encryption key from the auth session
	 * @param userId - Required when keyCache is configured. Identifies whose key to cache.
	 *
	 * @example
	 * ```typescript
	 * // Auth key available—derive workspace key and unlock
	 * keyManager.unlock(session.encryptionKey);
	 *
	 * // With key caching for instant unlock on page refresh
	 * keyManager.unlock(session.encryptionKey, session.userId);
	 * ```
	 */
	unlock(userKeyBase64: string, userId?: string): Promise<void>;

	/**
	 * Wipe local data and clear cached keys.
	 *
	 * Nuclear option for sign-out: calls `clearLocalData()` to destroy
 * IndexedDB/persistence, then clears the key cache. The workspace client
 * stays alive with no local data.
	 *
	 * Cancels any in-flight HKDF derivation from a prior `unlock()`.
	 * Always calls through to `client.clearLocalData()`—the client decides
	 * whether wiping is meaningful in its current mode.
	 *
	 * @example
	 * ```typescript
	 * // User explicitly signed out—destroy all local encrypted data
	 * await keyManager.wipe();
	 * ```
	 */
	wipe(): Promise<void>;

	/**
	 * Attempt to restore from a cached key.
	 *
	 * Reads from the `keyCache` for the given `userId`. If found, calls
	 * `unlock()` internally—triggering HKDF derivation and unlock without
	 * a network round-trip. Returns `true` if a cached key was found.
	 *
 * Use on page load to skip the server roundtrip when the key is still
	 * in the cache from a previous session.
	 *
	 * No-op if no `keyCache` was provided to the factory.
	 *
	 * @example
	 * ```typescript
	 * // On page load, try cache before hitting the server
	 * const restored = await keyManager.restoreKeyFromCache(userId);
	 * if (!restored) {
	 *   // No cached key—need to fetch from auth session
	 *   await authState.checkSession();
	 * }
	 * ```
	 */
	restoreKeyFromCache(userId: string): Promise<boolean>;
};

/**
 * Create a framework-agnostic key manager for a workspace client.
 *
 * Encapsulates the three hard parts of encryption lifecycle management:
 * 1. **Async HKDF bridging**—`deriveWorkspaceKey` is async (SubtleCrypto HKDF).
 *    The factory awaits the derivation and delivers the result, with race
 *    protection ensuring only the latest call's result applies.
 * 2. **Duplicate key dedup**—calling `unlock()` with the same base64 key is a no-op,
 *    so reactive systems can call it on every tick without waste.
 * 3. **Race protection**—a generation counter ensures stale HKDF results from a
 *    previous `unlock()` call never land after a newer one.
 *
 * Encryption state guarding (none/active) is the client's responsibility,
 * not the key manager's. The key manager always calls through to `clearLocalData()`.
 *
 * @param client - Workspace client surface implementing unlock and clearLocalData
 * @param config - Optional key cache for instant unlock on page refresh
 * @returns Imperative `unlock`/`wipe`/`restoreKeyFromCache` API for framework adapters to call
 *
 * @example
 * ```typescript
 * const keyManager = createKeyManager(workspaceClient);
 *
 * // Driven by your framework's reactive system:
 * keyManager.unlock(keyBase64);   // auth key available → derive + unlock
 * await keyManager.wipe();        // sign-out → destroy local data
 * ```
 */
export function createKeyManager(
	client: KeyManagerTarget,
	config?: KeyManagerConfig,
): KeyManager {
	// Zone 1 — Immutable state
	const keyCache = config?.keyCache;

	// Zone 2 — Mutable state
	let generation = 0;
	let lastKeyBase64: string | undefined;

	// Zone 3 — Private helpers
	async function deriveAndUnlock(userKey: Uint8Array, thisGeneration: number) {
		try {
			const wsKey = await deriveWorkspaceKey(userKey, client.id);
			if (thisGeneration === generation) client.unlock(wsKey);
			} catch (error) {
			console.error('[key-manager] Key derivation failed:', error);
		}
	}

	// Zone 4 — Private helpers
	function invalidateKey() {
		++generation;
		lastKeyBase64 = undefined;
	}

	async function unlockInternal(userKeyBase64: string, userId?: string) {
		if (userKeyBase64 === lastKeyBase64) return;
		lastKeyBase64 = userKeyBase64;

		const thisGeneration = ++generation;
		const userKey = base64ToBytes(userKeyBase64);

		await deriveAndUnlock(userKey, thisGeneration);

		if (keyCache && !userId) {
			console.warn(
				'[key-manager] keyCache configured but no userId provided—key not cached',
			);
		} else if (userId && keyCache) {
			await keyCache.set(userId, userKeyBase64);
		}
	}

	// Zone 5 — Public API
	return {
		async unlock(userKeyBase64, userId) {
			await unlockInternal(userKeyBase64, userId);
		},

		async wipe() {
			invalidateKey();
			await client.clearLocalData();
			if (keyCache) await keyCache.clear();
		},

		async restoreKeyFromCache(userId) {
			if (!keyCache) return false;
			const cachedKeyBase64 = await keyCache.get(userId);
			if (!cachedKeyBase64) return false;

			await unlockInternal(cachedKeyBase64, userId);
			return true;
		},
	};
}
