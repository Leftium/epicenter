import type { Brand } from 'wellcrafted/brand';

/**
 * Branded string representing the JSON-serialized encryption keyring.
 *
 * The underlying shape is `JSON.stringify(EncryptionKeys)` where `EncryptionKeys`
 * is an array of versioned user keys:
 *
 * ```json
 * [{ "version": 1, "userKeyBase64": "a2V5LW1hdGVyaWFsLi4u" }]
 * ```
 *
 * These keys come from the server auth session—not from `.env` or any local
 * config. The server derives them during authentication, and the client caches
 * them locally (via {@link UserKeyStore}) so the workspace can decrypt data
 * instantly on next launch without waiting for an auth roundtrip.
 *
 * The brand prevents accidentally passing an arbitrary string to
 * `UserKeyStore.set()` or treating a `UserKeyStore.get()` result as plain text.
 * The only way to produce this type is through the branded cast in
 * `create-workspace.ts` after `JSON.stringify(keys)`—store implementations
 * treat it as an opaque blob.
 */
export type EncryptionKeysJson = string & Brand<'EncryptionKeysJson'>;

/**
 * Platform-agnostic interface for persisting encryption keys across sessions.
 *
 * Stores the encryption keys as a JSON string—`JSON.stringify(EncryptionKey[])`
 * where each entry is `{ version: number, userKeyBase64: string }`. The store
 * interface deals only in opaque strings; callers handle serialization.
 *
 * Passing a `UserKeyStore` to `.withEncryption({ userKeyStore })` implies
 * auto-boot: the workspace loads the cached keys on startup and unlocks
 * immediately if available. No explicit boot call is needed.
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
 *   │  encryptionKeys: [{ version, userKeyBase64 }, ...]
 *   ▼
 * UserKeyStore.set(JSON.stringify(encryptionKeys))
 *   │  stored locally as opaque string
 *   ▼
 * App startup (before auth roundtrip completes)
 *   │  UserKeyStore.get() → JSON string | null
 *   │  consumed by auto-boot in whenReady
 *   ▼
 * auto-boot → JSON.parse → unlock(keys) → deriveWorkspaceKey per version
 *   │  base64 decoding + HKDF happens inside unlock()
 * ```
 *
 * ## With Cache vs Without Cache
 *
 * ```
 * WITHOUT UserKeyStore:              WITH UserKeyStore:
 *
 * App opens                          App opens
 *   │                                  │
 *   ▼                                  ▼
 * Auth roundtrip (network)           Read cached keys (local, <1ms)
 *   │  ⏳ 200–2000ms                   │
 *   ▼                                  ▼
 * Receive keys                       unlock() → data readable immediately
 *   │                                  │
 *   ▼                                  ▼  (in background)
 * unlock() → data readable           Auth roundtrip refreshes keys silently
 * ```
 *
 * The cache eliminates the auth roundtrip from the critical startup path.
 * For local-first apps where instant load is the whole point, this is essential.
 */
export type UserKeyStore = {
	/**
	 * Persist the latest encryption keys as a JSON string.
	 *
	 * Called after the workspace receives or refreshes valid keys from the
	 * auth session. Implementations store one value and overwrite any
	 * older cached entry.
	 */
	set(keysJson: EncryptionKeysJson): Promise<void>;
	/**
	 * Retrieve the cached encryption keys during startup.
	 *
	 * Called automatically during `whenReady` when a `UserKeyStore` is provided
	 * to `.withEncryption()`. Return `null` to skip auto-unlock and wait for
	 * the server session to provide keys.
	 */
	get(): Promise<EncryptionKeysJson | null>;
	/**
	 * Remove the cached key on sign-out or account switch.
	 *
	 * This should clear only the encryption-key entry owned by the cache, not
	 * unrelated storage used by the host app.
	 */
	delete(): Promise<void>;
};
