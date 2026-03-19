/**
 * # Encryption Primitives
 *
 * XChaCha20-Poly1305 encryption for workspace data, using `@noble/ciphers` (Cure53-audited,
 * synchronous). Chosen because `set()` must remain synchronous across 394+ call sites.
 *
 * XChaCha20-Poly1305 was chosen over AES-256-GCM because: (1) 2.3x faster in pure JS
 * (468K vs 201K ops/sec for 64B payloads in @noble/ciphers), (2) 24-byte nonce is safe
 * for random generation (no collision risk), (3) aligned with libsodium and WireGuard.
 * See @noble/ciphers benchmarks.
 *
 * ## Encryption Flow (10,000ft View)
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Auth Flow                                                         │
 * │  Server derives key from secret → sends base64 in session response │
 * │  Client decodes → stores in memory via KeyCache                    │
 * └────────────────────────┬────────────────────────────────────────────┘
 * │  key: Uint8Array | undefined
 *                          ▼
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Encrypted KV Wrapper (y-keyvalue-lww-encrypted.ts)                │
 * │                                                                     │
 * │  set(key, val)                                                      │
 * │    → JSON.stringify(val)                                            │
 * │    → encryptValue(json, key) → Uint8Array [fmt‖keyVer‖nonce‖ct‖tag]│
 * │    → encryptValue(json, key, aad?) for context binding             │
 * │    → inner CRDT stores EncryptedBlob (bare Uint8Array)             │
 * │                                                                     │
 * │  observer fires (inner CRDT change)                                │
 * │    → isEncryptedBlob(val)? decryptValue → JSON.parse → plaintext   │
 * │    → wrapper.map updated with plaintext                            │
 * │                                                                     │
 * │  get(key) → reads from plaintext map (cached, no re-decrypt)       │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Key Sources
 *
 * | Mode            | Key derivation                                              | Server decrypts? |
 * |-----------------|-------------------------------------------------------------|------------------|
 * | Cloud (SaaS)    | HKDF(SHA-256(current ENCRYPTION_SECRETS entry), "user:{userId}") | Yes         |
 * |                 | → per-user key in session; client HKDF → per-workspace key  |                  |
 * | Self-hosted     | Same HKDF hierarchy, your secret                            | Only you         |
 * | No auth / local | key: undefined → passthrough                                | N/A              |
 *
 * ## Related Modules
 *
 * - {@link ../y-keyvalue/y-keyvalue-lww-encrypted.ts} — Composition wrapper that wires these primitives into the CRDT
 * - {@link ./key-cache.ts} — Platform-agnostic key caching interface (survives page refresh)
 * - {@link ../y-keyvalue/y-keyvalue-lww.ts} — Underlying CRDT (unaware of encryption)
 *
 * @module
 */

import type { Brand } from 'wellcrafted/brand';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';

const NONCE_LENGTH = 24;

/**
 * Encrypted blob stored directly in the CRDT as a bare Uint8Array.
 *
 * Uses XChaCha20-Poly1305 with a self-describing binary header. The format
 * version lives at byte 0, eliminating the old `{ v, ct }` JSON wrapper.
 * Yjs `writeAny` serializes `Uint8Array` natively as binary (type tag 116).
 *
 * v:1 binary layout:
 * ```
 *  Byte:  0         1         2                        26
 *         +---------+---------+------------------------+---------------------------+
 *         | format  | key     |        nonce           |    ciphertext + tag       |
 *         | version | version |      (24 bytes)        |    (variable + 16)        |
 *         +---------+---------+------------------------+---------------------------+
 *         |  0x01   | 0x01-FF | random (CSPRNG)        | XChaCha20-Poly1305 output |
 *         +---------+---------+------------------------+---------------------------+
 *
 *  Total: 1 + 1 + 24 + len(plaintext) + 16 bytes
 * ```
 *
 * Detection: `value instanceof Uint8Array && value[0] === 1`.
 * User values in the CRDT are always JS objects (never Uint8Arrays),
 * so this check is a reliable discriminant.
 *
 * @example
 * ```typescript
 * const blob: EncryptedBlob = encryptValue('secret', key);
 * blob[0]; // 1 (format version)
 * blob[1]; // 1 (key version, default)
 * blob.slice(2, 26); // 24-byte random nonce
 * blob.slice(26); // ciphertext + 16-byte Poly1305 tag
 * ```
 */
type EncryptedBlob = Uint8Array & Brand<'EncryptedBlob'>;

/**
 * Generate a random 256-bit encryption key.
 *
 * Returns a cryptographically secure random key suitable for XChaCha20-Poly1305 encryption.
 * Use this to create new encryption keys for users or workspaces.
 *
 * @returns A 32-byte Uint8Array containing the encryption key
 *
 * @example
 * ```typescript
 * const key = generateEncryptionKey();
 * console.log(key.length); // 32
 * ```
 */
function generateEncryptionKey(): Uint8Array {
	return randomBytes(32);
}

/**
 * Encrypt a plaintext string using XChaCha20-Poly1305.
 *
 * Generates a random 24-byte nonce for each encryption, ensuring that
 * encrypting the same plaintext with the same key produces different ciphertexts.
 * Returns a bare `Uint8Array` with a self-describing binary header:
 * `formatVersion(1) || keyVersion(1) || nonce(24) || ciphertext || tag(16)`.
 *
 * Yjs `writeAny` serializes `Uint8Array` natively as binary (type tag 116),
 * eliminating base64 overhead and the old `{ v, ct }` JSON wrapper.
 *
 * @param plaintext - The string to encrypt
 * @param key - A 32-byte Uint8Array encryption key
 * @param aad - Optional additional authenticated data bound to ciphertext integrity
 * @param keyVersion - Key version from ENCRYPTION_SECRETS keyring (default 1). Embedded as byte 1.
 * @returns A bare Uint8Array: `[formatVersion, keyVersion, ...nonce(24), ...ciphertext, ...tag(16)]`
 *
 * @example
 * ```typescript
 * const key = generateEncryptionKey();
 * const encrypted = encryptValue('secret data', key);
 * encrypted[0]; // 1 (format version)
 * encrypted[1]; // 1 (key version)
 * ```
 */
function encryptValue(
	plaintext: string,
	key: Uint8Array,
	aad?: Uint8Array,
	keyVersion: number = 1,
): EncryptedBlob {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
	const nonce = randomBytes(NONCE_LENGTH);
	const cipher = aad
		? xchacha20poly1305(key, nonce, aad)
		: xchacha20poly1305(key, nonce);
	const data = new TextEncoder().encode(plaintext);
	const ciphertext = cipher.encrypt(data);

	// Pack formatVersion(1) || keyVersion(1) || nonce(24) || ciphertext || tag(16)
	const packed = new Uint8Array(2 + nonce.length + ciphertext.length);
	packed[0] = 1; // format version
	packed[1] = keyVersion;
	packed.set(nonce, 2);
	packed.set(ciphertext, 2 + nonce.length);

	return packed as EncryptedBlob;
}

/**
 * Decrypt an EncryptedBlob using XChaCha20-Poly1305.
 *
 * Validates the format version at `blob[0]` (must be 1), then reads `blob[1]`
 * as key version metadata, `blob[2..25]` as nonce, and `blob[26..]` as
 * ciphertext + 16-byte auth tag. Decrypts using the provided key.
 *
 * The format version check exists as a safety net for forward compatibility.
 * Today only v1 exists, but if a future client writes v2 blobs, this function
 * will throw a clear error instead of silently misinterpreting the binary layout.
 * Future format versions would add dispatch logic here.
 *
 * Key version (`blob[1]`) is NOT validated here—the caller is responsible for
 * selecting the correct key from the keyring via `getKeyVersion()`.
 *
 * @param blob - A branded EncryptedBlob (bare Uint8Array with format header)
 * @param key - The 32-byte Uint8Array encryption key used to encrypt the blob
 * @param aad - Optional additional authenticated data that must match encryption input
 * @returns The decrypted plaintext string
 * @throws If format version is unknown, auth tag is invalid, or decryption fails
 *
 * @example
 * ```typescript
 * const key = generateEncryptionKey();
 * const encrypted = encryptValue('secret data', key);
 * const decrypted = decryptValue(encrypted, key);
 * console.log(decrypted); // 'secret data'
 * ```
 */
function decryptValue(
	blob: EncryptedBlob,
	key: Uint8Array,
	aad?: Uint8Array,
): string {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');

	// Validate format version — today only v1 exists. Future versions would
	// dispatch to different decryption logic here instead of falling through.
	const formatVersion = blob[0];
	if (formatVersion !== 1) {
		throw new Error(
			`Unknown encryption format version: ${formatVersion}. This blob may require a newer client.`,
		);
	}

	// blob[1] = key version (caller responsibility to select correct key)
	const nonce = blob.slice(2, 2 + NONCE_LENGTH);
	const ciphertext = blob.slice(2 + NONCE_LENGTH);
	const cipher = aad
		? xchacha20poly1305(key, nonce, aad)
		: xchacha20poly1305(key, nonce);
	const data = cipher.decrypt(ciphertext);

	return new TextDecoder().decode(data);
}

/**
 * Read the key version from an EncryptedBlob without decrypting.
 *
 * The key version is stored at byte 1 of the blob and identifies which
 * secret from the ENCRYPTION_SECRETS keyring was used to encrypt this blob.
 *
 * @param blob - An EncryptedBlob to read the key version from
 * @returns The key version number (1-255)
 */
function getKeyVersion(blob: EncryptedBlob): number {
	return blob[1]!;
}

/**
 * Read the format version from an EncryptedBlob without decrypting.
 *
 * The format version is stored at byte 0 of the blob. Currently only
 * version 1 exists (XChaCha20-Poly1305 with the layout documented on
 * the `EncryptedBlob` type). Future versions may use different algorithms
 * or binary layouts.
 *
 * @param blob - An EncryptedBlob to read the format version from
 * @returns The format version number (currently always 1)
 */
function getFormatVersion(blob: EncryptedBlob): number {
	return blob[0]!;
}

/**
 * Type guard to check if a value is a valid EncryptedBlob.
 *
 * Checks that the value is a `Uint8Array` with format version 1 at byte 0.
 * User values stored in the CRDT are always JS objects (from schema definitions),
 * never `Uint8Array` instances, so this check is a reliable discriminant.
 *
 * Truncated or corrupted blobs that pass this check will fail during
 * `decryptValue()` and get quarantined by the encrypted wrapper's error
 * containment—they are not silently misinterpreted.
 *
 * @param value - The value to check
 * @returns True if value is a valid EncryptedBlob, false otherwise
 *
 * @example
 * ```typescript
 * const data = crdt.get('key');
 * if (isEncryptedBlob(data)) {
 *   const decrypted = decryptValue(data, key);
 * }
 * ```
 */
function isEncryptedBlob(value: unknown): value is EncryptedBlob {
	return value instanceof Uint8Array && value[0] === 1;
}

/**
 * Derive a 256-bit encryption key from a password using PBKDF2.
 *
 * Uses 600,000 iterations of PBKDF2-SHA256 to derive a key from a password
 * and salt. This is the first stage of the self-hosted encryption flow:
 *
 * ```
 * Password (user input, low entropy)
 *   → PBKDF2(password, salt, 600k iterations) → userKey (32 bytes, high entropy)
 *   → workspace.activateEncryption(userKey)
 *     → HKDF(userKey, "workspace:{id}") → workspaceKey (per-workspace isolation)
 *       → XChaCha20-Poly1305(plaintext, workspaceKey) → ciphertext
 * ```
 *
 * **Why two stages?** PBKDF2 and HKDF serve different roles:
 * - **PBKDF2** strengthens weak human input (slow, 600k iterations, brute-force resistant)
 * - **HKDF** splits one strong key into independent per-workspace keys (fast, <1ms, deterministic)
 *
 * PBKDF2 runs once per session (~500ms). HKDF runs once per workspace (<1ms each).
 * Without HKDF, all workspaces would share the same key—compromising one would
 * compromise all. Without PBKDF2, the password would be trivially brute-forceable.
 *
 * @param password - The user's password
 * @param salt - A 16-byte Uint8Array salt (typically from `deriveSalt(userId, workspaceId)`)
 * @returns A promise that resolves to a 32-byte Uint8Array user key
 *
 * @example
 * ```typescript
 * // Self-hosted password flow:
 * const salt = await deriveSalt(userId, workspaceId);
 * const userKey = await deriveKeyFromPassword(password, salt);
 * await workspace.activateEncryption(userKey); // internally derives per-workspace key via HKDF
 * ```
 */
async function deriveKeyFromPassword(
	password: string,
	salt: Uint8Array,
): Promise<Uint8Array> {
	const passwordKey = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits'],
	);

	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			hash: 'SHA-256',
			salt: salt.buffer as ArrayBuffer,
			iterations: 600_000,
		},
		passwordKey,
		256,
	);

	return new Uint8Array(derivedBits);
}

/**
 * Derive a 16-byte salt from a userId and workspaceId using SHA-256.
 *
 * Combines the userId and workspaceId, hashes them with SHA-256, and returns
 * the first 16 bytes as a salt. This ensures that the same user in different
 * workspaces gets different salts, and different users get different salts.
 *
 * @param userId - The user's unique identifier
 * @param workspaceId - The workspace's unique identifier
 * @returns A promise that resolves to a 16-byte Uint8Array salt
 *
 * @example
 * ```typescript
 * const salt = await deriveSalt('user123', 'workspace456');
 * console.log(salt.length); // 16
 * ```
 */
async function deriveSalt(
	userId: string,
	workspaceId: string,
): Promise<Uint8Array> {
	const combined = userId + workspaceId;
	const hash = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(combined),
	);

	return new Uint8Array(hash).slice(0, 16);
}

/**
 * Derive a per-workspace 256-bit encryption key from a user key via HKDF-SHA256.
 *
 * This is the second level of a two-level key hierarchy:
 * 1. **User key** (input)—from any source (server HKDF, PBKDF2 password, cache)
 * 2. **Workspace key** (output)—`HKDF(userKey, "workspace:{workspaceId}")`
 *
 * The separation ensures each workspace gets an independent key even from the same
 * user key. Compromising one workspace key reveals nothing about other workspaces.
 *
 * **Batteries-included in `.withEncryption()`**: You typically don't call this directly.
 * `workspace.activateEncryption(userKey)` calls it internally. This function is exported
 * for testing and for consumers that need manual key derivation outside the workspace builder.
 *
 * Deterministic—same inputs always produce the same key. No storage needed.
 * Uses Web Crypto `deriveBits` which is available in browser, Cloudflare Workers,
 * and Tauri WebView.
 *
 * The info string is a domain-separation label for HKDF (RFC 5869 §3.2),
 * not a version identifier. If the derivation scheme ever changes (hash
 * algorithm, salt policy), the blob format version handles migration—not
 * the info string. Vault Transit, Signal Protocol, libsodium, and AWS KMS
 * all use unversioned derivation context strings.
 *
 * @param userKey - A 32-byte Uint8Array user key (root key, NOT a workspace-specific key)
 * @param workspaceId - The workspace identifier (e.g. "tab-manager")
 * @returns A promise that resolves to a 32-byte Uint8Array per-workspace encryption key
 *
 * @example
 * ```typescript
 * // Typically called internally by workspace.activateEncryption(userKey):
 * //   const wsKey = await deriveWorkspaceKey(userKey, workspaceId);
 * //   store.activateEncryption(wsKey);
 *
 * // Direct usage (testing or manual key management):
 * const userKey = base64ToBytes(session.encryptionKey);
 * const wsKey = await deriveWorkspaceKey(userKey, 'tab-manager');
 * ```
 */
async function deriveWorkspaceKey(
	userKey: Uint8Array,
	workspaceId: string,
): Promise<Uint8Array> {
	const hkdfKey = await crypto.subtle.importKey(
		'raw',
		userKey.buffer as ArrayBuffer,
		'HKDF',
		false,
		['deriveBits'],
	);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: new TextEncoder().encode(`workspace:${workspaceId}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

/**
 * Convert a Uint8Array to a base64-encoded string.
 *
 * Uses the built-in `btoa` function with proper handling of binary data
 * via `String.fromCharCode`. Safe for all byte values (0-255).
 *
 * @param bytes - The bytes to encode
 * @returns A base64-encoded string
 *
 * @example
 * ```typescript
 * const bytes = new Uint8Array([1, 2, 3]);
 * const base64 = bytesToBase64(bytes);
 * console.log(base64); // 'AQID'
 * ```
 */
function bytesToBase64(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes));
}

/**
 * Convert a base64-encoded string to a Uint8Array.
 *
 * Uses the built-in `atob` function with proper handling of binary data
 * via `charCodeAt`. Safe for all byte values (0-255).
 *
 * @param base64 - The base64-encoded string
 * @returns A Uint8Array containing the decoded bytes
 *
 * @example
 * ```typescript
 * const base64 = 'AQID';
 * const bytes = base64ToBytes(base64);
 * console.log(bytes); // Uint8Array(3) [ 1, 2, 3 ]
 * ```
 */
function base64ToBytes(base64: string): Uint8Array {
	const binaryString = atob(base64);
	const bytes = new Uint8Array(binaryString.length);
	for (let i = 0; i < binaryString.length; i++) {
		bytes[i] = binaryString.charCodeAt(i);
	}
	return bytes;
}

export type { EncryptedBlob };
export {
	generateEncryptionKey,
	encryptValue,
	decryptValue,
	getKeyVersion,
	getFormatVersion,
	isEncryptedBlob,
	deriveKeyFromPassword,
	deriveSalt,
	bytesToBase64,
	base64ToBytes,
	deriveWorkspaceKey,
};

