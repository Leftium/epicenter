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
 *     wiring.connect(base64ToBytes(key));
 *   } else {
 *     wiring.disconnect({ wipe: authState.status === 'signing-out' });
 *   }
 * });
 * ```
 *
 * @module
 */

import type { EncryptionMode } from '../y-keyvalue/y-keyvalue-lww-encrypted.js';
import { bytesToBase64, deriveWorkspaceKey } from './index';
import type { KeyCache } from './key-cache';

/**
 * Minimal client surface the wiring needs to drive lock/unlock.
 *
 * Uses the current mode names (`'plaintext' | 'unlocked' | 'locked'`).
 * A later spec handles renaming.
 */
export type EncryptionWiringClient = {
	readonly id: string;
	readonly mode: EncryptionMode;
	lock(): void;
	unlock(key: Uint8Array): void;
	clearLocalData(): Promise<void>;
};


/**
 * Imperative connect/disconnect API for encryption lifecycle management.
 *
 * The factory owns the hard parts—async HKDF bridging, duplicate key dedup,
 * mode guard subtlety, and race protection. The consumer just pushes key
 * presence/absence from their framework's reactive system.
 */
export type EncryptionWiring = {
	/**
	 * Supply a user-level encryption key.
	 *
	 * Derives a per-workspace key via HKDF → calls `unlock()`.
	 * No-op if called with the same key as the previous `connect()`.
	 * If a `keyCache` was provided, caches the key bytes under `userId`.
	 *
	 * @param userKey - 32-byte user encryption key (decoded from auth session)
	 * @param userId - Required when keyCache is configured. Identifies whose key to cache.
	 */
	connect(userKey: Uint8Array, userId?: string): void;

	/**
	 * Remove the encryption key.
	 *
	 * - `wipe: true` → `clearLocalData()` (sign-out: wipe IndexedDB, keep client alive)
	 * - `wipe: false` (default) → `lock()` (soft lock: data preserved, writes blocked)
	 *
	 * Only acts when `mode === 'unlocked'`. No-op in plaintext/locked modes.
	 * Cancels any in-flight HKDF derivation from a prior `connect()`.
	 * If a `keyCache` was provided and `wipe` is true, clears the cache.
	 */
	disconnect(options?: { wipe?: boolean }): void;

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
 * Encapsulates the four hard parts of encryption lifecycle management:
 * 1. **Async-to-sync bridge** — `deriveWorkspaceKey` is async, `unlock()` is sync
 * 2. **Three-way key-loss branch** — sign-out (wipe) vs session expiry (lock) vs never-had-key (no-op)
 * 3. **Mode guard subtlety** — only act when `mode === 'unlocked'`
 * 4. **Race protection** — generation counter prevents stale HKDF results from landing
 *
	 * @param client - Minimal workspace client surface (id, mode, lock, unlock, clearLocalData)
	 * @param keyCache - Optional key cache for instant unlock on page refresh
	 * @returns Imperative connect/disconnect/loadCachedKey API
 *
 * @example
 * ```typescript
 * const wiring = createEncryptionWiring(workspaceClient);
 *
 * // On auth key available:
 * wiring.connect(userKey);
 *
 * // On sign-out:
 * wiring.disconnect({ wipe: true });
 *
 * // On session expiry:
 * wiring.disconnect();
 * ```
 */
export function createEncryptionWiring(
	client: EncryptionWiringClient,
	keyCache?: KeyCache,
): EncryptionWiring {
	// Zone 1 — Mutable state

	// Zone 2 — Mutable state
	let generation = 0;
	let lastKeyFingerprint: string | undefined;

	// Zone 3 — Private helpers
	function deriveAndUnlock(userKey: Uint8Array, gen: number) {
		void deriveWorkspaceKey(userKey, client.id).then((wsKey) => {
			if (gen === generation) client.unlock(wsKey);
		});
	}

	// Zone 4 — Public API
	return {
		connect(userKey, userId) {
			const fingerprint = bytesToBase64(userKey);
			if (fingerprint === lastKeyFingerprint) return;
			lastKeyFingerprint = fingerprint;

			const gen = ++generation;

			deriveAndUnlock(userKey, gen);

			if (userId && keyCache) {
				void keyCache.set(userId, userKey);
			}
		},

		disconnect({ wipe = false } = {}) {
			++generation;
			lastKeyFingerprint = undefined;

			if (client.mode === 'unlocked') {
				if (wipe) {
					void client.clearLocalData();
				} else {
					client.lock();
				}
			}

			if (wipe && keyCache) {
				void keyCache.clear();
			}
		},

		async loadCachedKey(userId) {
			if (!keyCache) return false;
			const cached = await keyCache.get(userId);
			if (!cached) return false;

			this.connect(cached, userId);
			return true;
		},
	};
}
