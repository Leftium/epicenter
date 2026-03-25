/**
 * Platform-agnostic interface for caching encryption keys.
 *
 * Stores the encryption key as a base64 string—the same format the auth
 * session provides and the workspace cache boundary restores. This keeps
 * the cache representation simple: the key enters as a string, caches as a
 * string, and only decodes to bytes once the workspace calls
 * `restoreEncryption()`.
 *
 * Every concrete backend stores strings natively. WXT storage wraps
 * `chrome.storage.session` for the extension, `sessionStorage` is string-only
 * in the browser, and Stronghold persists opaque values on desktop. The
 * interface matches that storage reality.
 *
 * | Platform         | Implementation                                            |
 * |------------------|-----------------------------------------------------------|
 * | Tauri desktop    | `tauri-plugin-stronghold` — encrypted vault, memory zeroization |
 * | Browser          | `sessionStorage` — survives refresh, clears on tab close  |
 * | Chrome extension | WXT storage (`session:` area over `chrome.storage.session`) — survives popup/sidebar reopens |
 * | Self-hosted      | No cache — user enters password each session              |
 *
 * @example
 * ```typescript
 * import { storage } from '@wxt-dev/storage';
 *
 * // Chrome extension implementation via WXT
 * const encryptionKeyItem = storage.defineItem<string | null>(
 *   'session:epicenter:encryption-key',
 *   { fallback: null },
 * );
 *
 * const extensionKeyCache: KeyCache = {
 *   async save(keyBase64) {
 *     await encryptionKeyItem.setValue(keyBase64);
 *   },
 *   async load() {
 *     return await encryptionKeyItem.getValue();
 *   },
 *   async clear() {
 *     await encryptionKeyItem.removeValue();
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
 *   │  consumed by workspace.restoreEncryption()
 *   ▼
 * restoreEncryption() → base64ToBytes → activateEncryption() → HKDF
 *   │  base64 decoding happens once, at the crypto boundary
 * ```
 *
 * Without a `KeyCache`, every page refresh requires a full auth roundtrip before
 * encrypted data can be read. With a cache, the workspace decrypts immediately
 * on launch using the cached key, then refreshes it silently when the session loads.
 *
 * ## Related Modules
 *
 * - {@link ../workspace/create-workspace.ts} — `withEncryption({ keyCache })` owns save, restore, and clear
 * - {@link ./index.ts} — Encryption primitives (`base64ToBytes` for key decoding at the crypto boundary)
 */
export type KeyCache = {
	/**
	 * Persist the latest base64-encoded encryption key.
	 *
	 * Called after the workspace receives or refreshes a valid key from the auth
	 * session. Implementations usually store one value and overwrite any older
	 * cached key.
	 */
	save(keyBase64: string): Promise<void>;
	/**
	 * Load the cached base64-encoded key during startup.
	 *
	 * `createWorkspace().withEncryption({ keyCache })` calls this before the auth
	 * roundtrip completes so encrypted data can unlock immediately. Return `null`
	 * to opt out and force the workspace to wait for the server session.
	 */
	load(): Promise<string | null>;
	/**
	 * Remove the cached key on sign-out or account switch.
	 *
	 * This should clear only the encryption-key entry owned by the cache, not
	 * unrelated storage used by the host app.
	 */
	clear(): Promise<void>;
};
