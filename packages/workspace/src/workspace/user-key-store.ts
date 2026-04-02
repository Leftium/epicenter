/**
 * Platform-agnostic interface for persisting encryption keys across sessions.
 *
 * Stores typed `EncryptionKeys` directly—implementations handle serialization
 * internally (JSON for IndexedDB/WXT, could be binary for Stronghold). Callers
 * pass and receive validated `EncryptionKeys` values, never raw strings.
 *
 * Passing a `UserKeyStore` to `.withEncryption({ userKeyStore })` implies
 * auto-boot: the workspace loads the cached keys on startup and unlocks
 * immediately if available. No explicit boot call is needed.
 *
 * | Platform         | Implementation                                            |
 * |------------------|-----------------------------------------------------------|
 * | Tauri desktop    | `tauri-plugin-stronghold` — encrypted vault, memory zeroization |
 * | Browser          | IndexedDB — survives refresh, clears on explicit delete   |
 * | Chrome extension | WXT storage (`session:` area over `chrome.storage.session`) — survives popup/sidebar reopens |
 * | Self-hosted      | No cache — user enters password each session              |
 *
 * ## How It Fits
 *
 * ```
 * Server (auth session)
 *   │  encryptionKeys: [{ version, userKeyBase64 }, ...]
 *   ▼
 * UserKeyStore.set(encryptionKeys)
 *   │  stored locally (serialization is implementation detail)
 *   ▼
 * App startup (before auth roundtrip completes)
 *   │  UserKeyStore.get() → EncryptionKeys | null
 *   │  consumed by auto-boot in whenReady
 *   ▼
 * auto-boot → unlock(keys) → deriveWorkspaceKey per version
 *   │  base64 decoding + HKDF happens inside unlock()
 * ```
 *
 * Without a `UserKeyStore`, every page refresh requires a full auth roundtrip
 * before encrypted data can be read. With a store, the workspace unlocks
 * immediately on launch using the cached keys, then refreshes them silently when
 * the session loads.
 */
import type { EncryptionKeys } from './encryption-key.js';

export type UserKeyStore = {
	/**
	 * Persist the latest encryption keys.
	 *
	 * Called after the workspace receives or refreshes valid keys from the
	 * auth session. Implementations serialize internally (e.g. JSON.stringify
	 * for IndexedDB) and overwrite any older cached entry.
	 */
	set(keys: EncryptionKeys): Promise<void>;
	/**
	 * Retrieve the cached encryption keys during startup.
	 *
	 * Called automatically during `whenReady` when a `UserKeyStore` is provided
	 * to `.withEncryption()`. Implementations deserialize and validate with the
	 * ArkType `EncryptionKeys` schema, returning `null` on any failure (corrupt
	 * data, schema mismatch, missing entry). Return `null` to skip auto-unlock
	 * and wait for the server session to provide keys.
	 */
	get(): Promise<EncryptionKeys | null>;
	/**
	 * Remove the cached key on sign-out or account switch.
	 *
	 * This should clear only the encryption-key entry owned by the cache, not
	 * unrelated storage used by the host app.
	 */
	delete(): Promise<void>;
};
