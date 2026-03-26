/**
 * Platform-agnostic interface for caching user encryption keys.
 *
 * Stores the user key as a base64 string—the same format the auth session
 * provides and the workspace encryption boundary restores. This keeps the
 * cache representation simple: the key enters as a string, caches as a
 * string, and only decodes to bytes once the workspace calls
 * `restoreEncryptionFromCache()`.
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
 * ## How It Fits
 *
 * ```
 * Server (auth session)
 *   │  userKeyBase64: base64 string
 *   ▼
 * UserKeyCache.save(userKeyBase64)
 *   │  stored locally as-is (no conversion needed)
 *   ▼
 * App startup (before auth roundtrip completes)
 *   │  UserKeyCache.load() → base64 string | null (cached from last session)
 *   │  consumed by workspace.encryption.restoreEncryptionFromCache()
 *   ▼
 * restoreEncryptionFromCache() → base64ToBytes → activate() → HKDF
 *   │  base64 decoding happens once, at the crypto boundary
 * ```
 *
 * Without a `UserKeyCache`, every page refresh requires a full auth roundtrip
 * before encrypted data can be read. With a cache, the workspace decrypts
 * immediately on launch using the cached key, then refreshes it silently when
 * the session loads.
 */
export type UserKeyCache = {
	/**
	 * Persist the latest base64-encoded user key.
	 *
	 * Called after the workspace receives or refreshes a valid user key from the
	 * auth session. Implementations usually store one value and overwrite any
	 * older cached key.
	 */
	save(userKeyBase64: string): Promise<void>;
	/**
	 * Load the cached base64-encoded user key during startup.
	 *
	 * `createWorkspace().withEncryption({ userKeyCache })` calls this before the
	 * auth roundtrip completes so encrypted data can unlock immediately. Return
	 * `null` to opt out and force the workspace to wait for the server session.
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
