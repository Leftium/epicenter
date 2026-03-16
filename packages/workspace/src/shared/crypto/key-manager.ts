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
 * its auth state and calls the imperative `setKey`/`lock`/`wipe` API:
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
 *     if (key) keyManager.setKey(key);
 *     else if (authState.status === 'signing-out') keyManager.wipe();
 *     else keyManager.lock();
 *   });
 * });
 * ```
 *
 * @module
 */

import { base64ToBytes, deriveWorkspaceKey } from './index';
import type { KeyCache } from './key-cache';

/**
 * Minimal client surface the key manager needs to drive lock/unlock.
 *
 * Intentionally narrow—only the methods the key manager actually calls.
 * The key manager never reads mode (plaintext/locked/unlocked); mode
 * guarding is the client's responsibility. Any workspace client that
 * implements these members can be managed.
 */
export type KeyManagerTarget = {
	readonly id: string;
	lock(): void;
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
 * Imperative setKey/lock/wipe API for encryption lifecycle management.
 *
 * The factory owns the hard parts—async HKDF bridging, duplicate key dedup,
 * and race protection. The consumer just pushes key presence/absence from
 * their framework's reactive system.
 *
 * Mode guarding (plaintext/locked/unlocked) is the client's job—the key
 * manager always calls through regardless of mode.
 */
export type KeyManager = {
	/**
	 * Supply a user-level encryption key (base64-encoded).
	 *
	 * Decodes base64 → derives per-workspace key via HKDF → calls `unlock()`.
	 * No-op if called with the same key as the previous `setKey()`, so reactive
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
	 * keyManager.setKey(session.encryptionKey);
	 *
	 * // With key caching for instant unlock on page refresh
	 * keyManager.setKey(session.encryptionKey, session.userId);
	 * ```
	 */
	setKey(userKeyBase64: string, userId?: string): void;

	/**
	 * Soft-lock the workspace.
	 *
	 * Preserves local data but blocks encrypted writes. Use when the auth
	 * session expires or the encryption key is revoked—data stays on disk
	 * for re-unlock later.
	 *
	 * Cancels any in-flight HKDF derivation from a prior `setKey()`.
	 * Always calls through to `client.lock()`—the client decides whether
	 * locking is meaningful in its current mode.
	 *
	 * @example
	 * ```typescript
	 * // Session expired but user might re-authenticate—keep data intact
	 * keyManager.lock();
	 * ```
	 */
	lock(): void;

	/**
	 * Wipe local data and clear cached keys.
	 *
	 * Nuclear option for sign-out: calls `clearLocalData()` to destroy
	 * IndexedDB/persistence, then clears the key cache. The workspace client
	 * stays alive but is locked with no local data.
	 *
	 * Cancels any in-flight HKDF derivation from a prior `setKey()`.
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
	 * `setKey()` internally—triggering HKDF derivation and unlock without
	 * a network round-trip. Returns `true` if a cached key was found.
	 *
	 * Use on page load to skip the "locked" state when the key is still
	 * in the cache from a previous session.
	 *
	 * No-op if no `keyCache` was provided to the factory.
	 *
	 * @example
	 * ```typescript
	 * // On page load, try cache before hitting the server
	 * const restored = await keyManager.restoreKey(userId);
	 * if (!restored) {
	 *   // No cached key—need to fetch from auth session
	 *   await authState.checkSession();
	 * }
	 * ```
	 */
	restoreKey(userId: string): Promise<boolean>;
};

/**
 * Create a framework-agnostic key manager for a workspace client.
 *
 * Encapsulates the three hard parts of encryption lifecycle management:
 * 1. **Async-to-sync bridge**—`deriveWorkspaceKey` is async (SubtleCrypto HKDF),
 *    but the workspace client's `unlock()` is sync. The factory fires-and-forgets
 *    the derivation and delivers the result when ready.
 * 2. **Duplicate key dedup**—calling `setKey()` with the same base64 key is a no-op,
 *    so reactive systems can call it on every tick without waste.
 * 3. **Race protection**—a generation counter ensures stale HKDF results from a
 *    previous `setKey()` call never land after a newer one.
 *
 * Mode guarding (plaintext/locked/unlocked) is the client's responsibility,
 * not the key manager's. The key manager always calls through to `lock()`/`clearLocalData()`.
 *
 * @param client - Workspace client surface implementing lock, unlock, and clearLocalData
 * @param config - Optional key cache for instant unlock on page refresh
 * @returns Imperative `setKey`/`lock`/`wipe`/`restoreKey` API for framework adapters to call
 *
 * @example
 * ```typescript
 * const keyManager = createKeyManager(workspaceClient);
 *
 * // Driven by your framework's reactive system:
 * keyManager.setKey(keyBase64);   // auth key available → derive + unlock
 * keyManager.lock();              // session expired → soft-lock
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
	function deriveAndUnlock(userKey: Uint8Array, thisGeneration: number) {
		void deriveWorkspaceKey(userKey, client.id).then((wsKey) => {
				if (thisGeneration === generation) client.unlock(wsKey);
			})
			.catch((error) => {
				console.error('[key-manager] Key derivation failed:', error);
			});
	}

	// Zone 4 — Private helpers
	function invalidateKey() {
		++generation;
		lastKeyBase64 = undefined;
	}

	function setKeyInternal(userKeyBase64: string, userId?: string) {
		if (userKeyBase64 === lastKeyBase64) return;
		lastKeyBase64 = userKeyBase64;

		const thisGeneration = ++generation;
		const userKey = base64ToBytes(userKeyBase64);

		deriveAndUnlock(userKey, thisGeneration);

		if (keyCache && !userId) {
			console.warn(
				'[key-manager] keyCache configured but no userId provided—key not cached',
			);
		} else if (userId && keyCache) {
			void keyCache.set(userId, userKeyBase64);
		}
	}

	// Zone 5 — Public API
	return {
		setKey(userKeyBase64, userId) {
			setKeyInternal(userKeyBase64, userId);
		},

		lock() {
			invalidateKey();
			client.lock();
		},

		async wipe() {
			invalidateKey();
			await client.clearLocalData();
			if (keyCache) void keyCache.clear();
		},

		async restoreKey(userId) {
			if (!keyCache) return false;
			const cachedKeyBase64 = await keyCache.get(userId);
			if (!cachedKeyBase64) return false;

			setKeyInternal(cachedKeyBase64, userId);
			return true;
		},
	};
}
