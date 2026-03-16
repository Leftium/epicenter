/**
 * Framework-agnostic encryption wiring factory.
 *
 * Bridges the async gap between auth sessions (which provide an encryption key)
 * and the workspace client (which needs a derived key to unlock). Handles
 * HKDF derivation, race protection via a generation counter, and optional key
 * caching—so per-app reactive glue is ~5 lines instead of 50+.
 *
 * @example
 * ```typescript
 * const wiring = createEncryptionWiring(workspaceClient);
 *
 * // Svelte adapter (~5 lines of $effect glue)
 * $effect(() => {
 *   const key = authState.encryptionKey;
 *   if (key) {
 *     wiring.connect(key);
 *   } else if (authState.status === 'signing-out') {
 *     wiring.wipeLocalData();
 *   } else {
 *     wiring.lock();
 *   }
 * });
 * ```
 *
 * @module
 */

import { base64ToBytes, deriveWorkspaceKey } from './index';
import type { KeyCache } from './key-cache';

/**
 * Minimal client surface the wiring needs to drive lock/unlock.
 *
 * The wiring never reads mode—mode guarding is the client's responsibility.
 * This keeps the wiring focused on key lifecycle only.
 */
export type EncryptionWiringClient = {
	readonly id: string;
	lock(): void;
	unlock(key: Uint8Array): void;
	clearLocalData(): Promise<void>;
};

/**
 * Configuration for the encryption wiring factory.
 */
export type EncryptionWiringConfig = {
	/** Optional key cache for instant unlock on page refresh. */
	keyCache?: KeyCache;
};

/**
 * Imperative connect/lock/wipe API for encryption lifecycle management.
 *
 * The factory owns the hard parts—async HKDF bridging, duplicate key dedup,
 * and race protection. The consumer just pushes key presence/absence from
 * their framework's reactive system. Mode guarding is the client's job.
 */
export type EncryptionWiring = {
	/**
	 * Supply a user-level encryption key (base64-encoded).
	 *
	 * Decodes base64 → derives per-workspace key via HKDF → calls `unlock()`.
	 * No-op if called with the same key as the previous `connect()`.
	 * If a `keyCache` was provided, caches the base64 key under `userId`.
	 *
	 * @param userKeyBase64 - Base64-encoded user encryption key from the auth session
	 * @param userId - Required when keyCache is configured. Identifies whose key to cache.
	 */
	connect(userKeyBase64: string, userId?: string): void;

	/**
	 * Soft-lock the workspace.
	 *
	 * Preserves local data but blocks encrypted writes. Use when the auth
	 * session expires or the encryption key is revoked—data stays on disk
	 * for re-unlock later.
	 *
	 * Always calls through to `client.lock()`—the client decides whether
	 * locking is meaningful in its current mode.
	 * Cancels any in-flight HKDF derivation from a prior `connect()`.
	 */
	lock(): void;

	/**
	 * Wipe local data and clear cached keys.
	 *
	 * Nuclear option for sign-out: calls `clearLocalData()` to nuke
	 * IndexedDB/persistence, then clears the key cache. The workspace client
	 * stays alive but is locked with no local data.
	 *
	 * Always calls through to `client.clearLocalData()`—the client decides
	 * whether wiping is meaningful in its current mode.
	 * Cancels any in-flight HKDF derivation from a prior `connect()`.
	 * If a `keyCache` was provided, clears the cache.
	 */
	wipeLocalData(): void;

	/**
	 * Attempt to restore from a cached key.
	 *
	 * Reads from the `keyCache` for the given `userId`. If found, calls
	 * `connect()` internally. Returns `true` if a cached key was found
	 * and `connect()` was initiated.
	 *
	 * No-op if no `keyCache` was provided.
	 */
	loadCachedKey(userId: string): Promise<boolean>;
};

/**
 * Create a framework-agnostic encryption wiring for a workspace client.
 *
 * Encapsulates the three hard parts of encryption lifecycle management:
 * 1. **Async-to-sync bridge** — `deriveWorkspaceKey` is async, `unlock()` is sync
 * 2. **Duplicate key dedup** — same key twice is a no-op
 * 3. **Race protection** — generation counter prevents stale HKDF results from landing
 *
 * Mode guarding (plaintext/locked/unlocked) is the client's responsibility,
 * not the wiring's. The wiring always calls through to `lock()` / `clearLocalData()`.
 *
 * @param client - Minimal workspace client surface (id, lock, unlock, clearLocalData)
 * @param config - Optional configuration (keyCache for instant unlock on page refresh)
 * @returns Imperative connect/lock/wipeLocalData/loadCachedKey API
 *
 * @example
 * ```typescript
 * const wiring = createEncryptionWiring(workspaceClient);
 *
 * // On auth key available:
 * wiring.connect(keyBase64);
 *
 * // On sign-out:
 * wiring.wipeLocalData();
 *
 * // On session expiry:
 * wiring.lock();
 * ```
 */
export function createEncryptionWiring(
	client: EncryptionWiringClient,
	config?: EncryptionWiringConfig,
): EncryptionWiring {
	// Zone 1 — Immutable state
	const keyCache = config?.keyCache;

	// Zone 2 — Mutable state
	let generation = 0;
	let lastKeyBase64: string | undefined;

	// Zone 3 — Private helpers
	function deriveAndUnlock(userKey: Uint8Array, thisGeneration: number) {
		void deriveWorkspaceKey(userKey, client.id).then((wsKey) => {
			if (thisGeneration === generation) client.unlock(wsKey);
		});
	}

	// Zone 4 — Private helpers
	function invalidateKey() {
		++generation;
		lastKeyBase64 = undefined;
	}

	// Zone 5 — Public API
	return {
		connect(userKeyBase64, userId) {
			if (userKeyBase64 === lastKeyBase64) return;
			lastKeyBase64 = userKeyBase64;

			const thisGeneration = ++generation;
			const userKey = base64ToBytes(userKeyBase64);

			deriveAndUnlock(userKey, thisGeneration);

			if (keyCache && !userId) {
				console.warn(
					'[encryption-wiring] keyCache configured but no userId provided—key not cached',
				);
			} else if (userId && keyCache) {
				void keyCache.set(userId, userKeyBase64);
			}
		},

		lock() {
			invalidateKey();
			client.lock();
		},

		wipeLocalData() {
			invalidateKey();
			void client.clearLocalData();
			if (keyCache) void keyCache.clear();
		},

		async loadCachedKey(userId) {
			if (!keyCache) return false;
			const cachedKeyBase64 = await keyCache.get(userId);
			if (!cachedKeyBase64) return false;

			this.connect(cachedKeyBase64, userId);
			return true;
		},
	};
}
