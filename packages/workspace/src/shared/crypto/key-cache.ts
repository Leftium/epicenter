/**
 * Platform-agnostic interface for caching encryption keys.
 *
 * Stores the encryption key as a base64 string—the same format
 * the auth session provides and `activateEncryption()` accepts. This avoids any
 * `Uint8Array ↔ base64` round-trips: the key enters as a string, caches
 * as a string, and passes straight back to `activateEncryption()` on reload.
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
 *   async save(keyBase64) {
 *     await chrome.storage.session.set({ ek: keyBase64 });
 *   },
 *   async load() {
 *     const result = await chrome.storage.session.get('ek');
 *     return result.ek ?? null;
 *   },
 *   async clear() {
 *     await chrome.storage.session.remove('ek');
 *   },
 * };
 *
 * // Browser implementation
 * const browserKeyCache: KeyCache = {
 *   async save(keyBase64) {
 *     sessionStorage.setItem('ek', keyBase64);
 *   },
 *   async load() {
 *     return sessionStorage.getItem('ek');
 *   },
 *   async clear() {
 *     sessionStorage.removeItem('ek');
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
 * KeyCache.save(keyBase64)
 *   │  stored locally as-is (no conversion needed)
 *   ▼
 * App startup (before auth roundtrip completes)
 *   │  KeyCache.load() → base64 string | null (cached from last session)
 *   │  passed directly to keyManager.activateEncryption(keyBase64)
 *   ▼
 * activateEncryption() → base64ToBytes → HKDF → activateEncryption
 *   │  base64 decoding happens once, at the crypto boundary
 * ```
 *
 * Without a `KeyCache`, every page refresh requires a full auth roundtrip before
 * encrypted data can be read. With a cache, the workspace decrypts immediately
 * on launch using the cached key, then refreshes it silently when the session loads.
 *
 * ## Related Modules
 *
 * - {@link ../workspace/create-workspace.ts} — `withEncryption()` calls `onActivate` / `onDeactivate` hooks that close over this cache
 * - {@link ./index.ts} — Encryption primitives (`base64ToBytes` for key decoding at the crypto boundary)
 */
export type KeyCache = {
	/** Save the base64-encoded encryption key. */
	save(keyBase64: string): Promise<void>;
	/** Load the cached base64-encoded key, or null if not cached. */
	load(): Promise<string | null>;
	/** Clear all cached keys (sign-out or user switch). */
	clear(): Promise<void>;
};
