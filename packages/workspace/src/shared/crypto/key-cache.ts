/**
 * Platform-agnostic interface for caching encryption keys.
 *
 * Stores the per-user encryption key as a base64 string—the same format
 * the auth session provides and `unlock()` accepts. This avoids any
 * `Uint8Array ↔ base64` round-trips: the key enters as a string, caches
 * as a string, and passes straight back to `unlock()` on reload.
 *
 * Every concrete backend stores strings natively (`chrome.storage.session`
 * serializes to JSON, `sessionStorage` is string-only), so the interface
 * matches the storage reality.
 *
 * | Platform         | Implementation                                            |
 * |------------------|-----------------------------------------------------------|
 * | Tauri desktop    | `tauri-plugin-stronghold` — encrypted vault, memory zeroization |
 * | Browser          | `sessionStorage` — survives refresh, clears on tab close  |
 * | Chrome extension | `chrome.storage.session` — survives popup/sidebar reopens  |
 * | Self-hosted      | No cache — user enters password each session              |
 *
 * @example
 * ```typescript
 * // Chrome extension implementation
 * const chromeKeyCache: KeyCache = {
 *   async set(userId, keyBase64) {
 *     await chrome.storage.session.set({ [`ek:${userId}`]: keyBase64 });
 *   },
 *   async get(userId) {
 *     const result = await chrome.storage.session.get(`ek:${userId}`);
 *     return result[`ek:${userId}`];
 *   },
 *   async clear() {
 *     const all = await chrome.storage.session.get(null);
 *     const ekKeys = Object.keys(all).filter((k) => k.startsWith('ek:'));
 *     await chrome.storage.session.remove(ekKeys);
 *   },
 * };
 *
 * // Browser implementation
 * const browserKeyCache: KeyCache = {
 *   async set(userId, keyBase64) {
 *     sessionStorage.setItem(`ek:${userId}`, keyBase64);
 *   },
 *   async get(userId) {
 *     return sessionStorage.getItem(`ek:${userId}`) ?? undefined;
 *   },
 *   async clear() {
 *     for (const key of Object.keys(sessionStorage)) {
 *       if (key.startsWith('ek:')) sessionStorage.removeItem(key);
 *     }
 *   },
 * };
 * ```
 *
 * ## How It Fits
 *
 * ```
 * Server (auth session)
 *   │  encryptionKey: base64 string
 *   ▼
 * KeyCache.set(userId, keyBase64)
 *   │  stored locally as-is (no conversion needed)
 *   ▼
 * App startup (before auth roundtrip completes)
 *   │  KeyCache.get(userId) → base64 string (cached from last session)
 *   │  passed directly to keyManager.unlock(keyBase64)
 *   ▼
 * unlock() → base64ToBytes → HKDF → unlock
 *   │  base64 decoding happens once, at the crypto boundary
 * ```
 *
 * Without a `KeyCache`, every page refresh requires a full auth roundtrip before
 * encrypted data can be read. With a cache, the workspace decrypts immediately
 * on launch using the cached key, then refreshes it silently when the session loads.
 *
 * ## Related Modules
 *
 * - {@link ./key-manager.ts} — `unlock()` accepts base64 strings, `restoreKeyFromCache()` reads from this cache
 * - {@link ./index.ts} — Encryption primitives (`base64ToBytes` for key decoding at the crypto boundary)
 */
export type KeyCache = {
	/** Store the base64-encoded encryption key for this user. */
	set(userId: string, keyBase64: string): Promise<void>;
	/** Retrieve the cached base64-encoded key, or undefined if not cached. */
	get(userId: string): Promise<string | undefined>;
	/** Clear all cached keys (sign-out or user switch). */
	clear(): Promise<void>;
};
