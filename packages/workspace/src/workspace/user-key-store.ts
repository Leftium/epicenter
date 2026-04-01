/**
 * Platform-agnostic interface for persisting user encryption keys.
 *
 * Stores the user key as a base64 string—the same format the auth session
 * provides and the workspace unlock boundary restores. This keeps the
 * cache representation simple: the key enters as a string, caches as a
 * string, and only decodes to bytes once the workspace calls `unlock()`.
 *
 * Passing a `UserKeyStore` to `.withEncryption({ userKeyStore })` implies
 * auto-boot: the workspace loads the cached key on startup and unlocks
 * immediately if one is available. No explicit boot call is needed.
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
 * UserKeyStore.set(userKeyBase64)
 *   │  stored locally as-is (no conversion needed)
 *   ▼
 * App startup (before auth roundtrip completes)
 *   │  UserKeyStore.get() → base64 string | null
 *   │  consumed by auto-boot in whenReady
 *   ▼
 * auto-boot → base64ToBytes → unlock() → HKDF
 *   │  base64 decoding happens once, at the crypto boundary
 * ```
 *
 * Without a `UserKeyStore`, every page refresh requires a full auth roundtrip
 * before encrypted data can be read. With a store, the workspace unlocks
 * immediately on launch using the cached key, then refreshes it silently when
 * the session loads.
 */
export type UserKeyStore = {
	/**
	 * Persist the latest base64-encoded user key.
	 *
	 * Called after the workspace receives or refreshes a valid user key from the
	 * auth session. Implementations usually store one value and overwrite any
	 * older cached key.
	 */
	set(userKeyBase64: string): Promise<void>;
	/**
	 * Retrieve the cached base64-encoded user key during startup.
	 *
	 * Called automatically during `whenReady` when a `UserKeyStore` is provided
	 * to `.withEncryption()`. Return `null` to skip auto-unlock and wait for
	 * the server session to provide a key.
	 */
	get(): Promise<string | null>;
	/**
	 * Remove the cached key on sign-out or account switch.
	 *
	 * This should clear only the encryption-key entry owned by the cache, not
	 * unrelated storage used by the host app.
	 */
	delete(): Promise<void>;
};
