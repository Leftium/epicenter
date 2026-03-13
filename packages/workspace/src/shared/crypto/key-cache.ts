/**
 * Platform-agnostic interface for caching encryption keys.
 *
 * The workspace layer doesn't care where the key lives—it only calls
 * `getKey()` on every operation. But between app restarts and tab
 * refreshes, re-deriving the key from the server adds a network
 * roundtrip. Implementations of `KeyCache` store the key locally so
 * the workspace can decrypt immediately on launch.
 *
 * | Platform         | Implementation                                            |
 * |------------------|-----------------------------------------------------------|
 * | Tauri desktop    | `tauri-plugin-stronghold` — encrypted vault, memory zeroization |
 * | Browser          | `sessionStorage` — survives refresh, clears on tab close  |
 * | Self-hosted      | No cache — user enters password each session              |
 *
 * @example
 * ```typescript
 * // Tauri implementation (pseudocode)
 * const tauriKeyCache: KeyCache = {
 *   async set(userId, key) {
 *     await stronghold.save(`encryption-key:${userId}`, key);
 *   },
 *   async get(userId) {
 *     return stronghold.read(`encryption-key:${userId}`);
 *   },
 *   async clear() {
 *     await stronghold.clearAll();
 *   },
 * };
 *
 * // Browser implementation
 * const browserKeyCache: KeyCache = {
 *   async set(userId, key) {
 *     sessionStorage.setItem(`ek:${userId}`, bytesToBase64(key));
 *   },
 *   async get(userId) {
 *     const stored = sessionStorage.getItem(`ek:${userId}`);
 *     return stored ? base64ToBytes(stored) : undefined;
 *   },
 *   async clear() {
 *     for (const key of Object.keys(sessionStorage)) {
 *       if (key.startsWith('ek:')) sessionStorage.removeItem(key);
 *     }
 *   },
 * };
 * ```
 */
export type KeyCache = {
	/** Store encryption key for this user. */
	set(userId: string, key: Uint8Array): Promise<void>;
	/** Retrieve cached key, or undefined if not cached. */
	get(userId: string): Promise<Uint8Array | undefined>;
	/** Clear all cached keys (logout or user switch). */
	clear(): Promise<void>;
};
