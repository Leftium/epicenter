/**
 * # Encryption Primitives
 *
 * AES-256-GCM encryption for workspace data, using `@noble/ciphers` (Cure53-audited,
 * synchronous). Chosen because `set()` must remain synchronous across 394+ call sites.
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
 * │    → encryptValue(json, key) → { v: 1, ct: Uint8Array(nonce‖ct‖tag) }
 * │    → encryptValue(json, key, aad?) for context binding            │
 * │    → inner CRDT stores EncryptedBlob                               │
 * │                                                                     │
 * │  observer fires (inner CRDT change)                                │
 * │    → isEncryptedBlob(val)? decryptValue → JSON.parse → plaintext  │
 * │    → wrapper.map updated with plaintext                            │
 * │                                                                     │
 * │  get(key) → reads from plaintext map (cached, no re-decrypt)      │
 * └─────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * ## Key Sources
 *
 * | Mode            | Key derivation                           | Server decrypts? |
 * |-----------------|------------------------------------------|------------------|
 * | Cloud (SaaS)    | SHA-256(BETTER_AUTH_SECRET)               | Yes              |
 * | Self-hosted     | PBKDF2(password, salt, 600k iterations)  | No (zero-knowledge) |
 * | No auth / local | key: undefined → passthrough             | N/A              |
 *
 * ## Related Modules
 *
 * - {@link ../y-keyvalue/y-keyvalue-lww-encrypted.ts} — Composition wrapper that wires these primitives into the CRDT
 * - {@link ./key-cache.ts} — Platform-agnostic key caching interface (survives page refresh)
 * - {@link ../y-keyvalue/y-keyvalue-lww.ts} — Underlying CRDT (unaware of encryption)
 *
 * @module
 */

import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';

/**
 * Encrypted blob stored and synced as binary.
 *
 * Uses AES-256-GCM with a 12-byte nonce and 16-byte authentication tag.
 * `ct` is a raw `Uint8Array` of `nonce(12) || ciphertext || tag(16)`,
 * stored natively by Yjs `writeAny` as binary (type tag 116).
 *
 * Field names are compact (`ct`, `v`) because this type is
 * persisted in the workspace database and synced across clients.
 *
 * @example
 * ```typescript
 * const encrypted: EncryptedBlob = {
 *   v: 1,
 *   ct: new Uint8Array([...nonce, ...ciphertext, ...tag]),
 * };
 * ```
 */
type EncryptedBlob = { v: 1; ct: Uint8Array };

/**
 * Generate a random 256-bit encryption key.
 *
 * Returns a cryptographically secure random key suitable for AES-256-GCM encryption.
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
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Generates a random 12-byte nonce for each encryption, ensuring that
 * encrypting the same plaintext with the same key produces different ciphertexts.
 * The nonce is prepended to the ciphertext in the output Uint8Array:
 * `ct = Uint8Array(nonce(12) || ciphertext || tag(16))`.
 *
 * Returns an EncryptedBlob with raw binary `ct`. Yjs `writeAny` serializes
 * `Uint8Array` natively as binary (type tag 116), eliminating base64 overhead.
 *
 * @param plaintext - The string to encrypt
 * @param key - A 32-byte Uint8Array encryption key
 * @param aad - Optional additional authenticated data bound to ciphertext integrity
 * @returns An EncryptedBlob with raw binary nonce+ciphertext+tag
 *
 * @example
 * ```typescript
 * const key = generateEncryptionKey();
 * const encrypted = encryptValue('secret data', key);
 * console.log(encrypted);
 * // { v: 1, ct: Uint8Array(...) }
 * ```
 */
function encryptValue(
	plaintext: string,
	key: Uint8Array,
	aad?: Uint8Array,
): EncryptedBlob {
	if (key.length !== 32)
		throw new Error('Encryption key must be 32 bytes (AES-256)');
	const nonce = randomBytes(12);
	const cipher = aad ? gcm(key, nonce, aad) : gcm(key, nonce);
	const data = new TextEncoder().encode(plaintext);
	const ciphertext = cipher.encrypt(data);

	// Pack nonce || ciphertext || tag into a single buffer
	const packed = new Uint8Array(nonce.length + ciphertext.length);
	packed.set(nonce, 0);
	packed.set(ciphertext, nonce.length);

	return {
		v: 1,
		ct: packed,
	};
}

/**
 * Decrypt an EncryptedBlob using AES-256-GCM.
 *
 * Slices the first 12 bytes of `ct` as the nonce and decrypts the remaining
 * bytes (ciphertext + 16-byte GCM auth tag) using the provided key.
 * Throws if the authentication tag is invalid or decryption fails.
 *
 * @param blob - An EncryptedBlob with binary `ct`
 * @param key - The 32-byte Uint8Array encryption key used to encrypt the blob
 * @param aad - Optional additional authenticated data that must match encryption input
 * @returns The decrypted plaintext string
 * @throws If the authentication tag is invalid or decryption fails
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
	if (key.length !== 32)
		throw new Error('Encryption key must be 32 bytes (AES-256)');
	const packed = blob.ct;
	const nonce = packed.slice(0, 12);
	const ciphertext = packed.slice(12);
	const cipher = aad ? gcm(key, nonce, aad) : gcm(key, nonce);
	const data = cipher.decrypt(ciphertext);

	return new TextDecoder().decode(data);
}

/**
 * Type guard to check if a value is a valid EncryptedBlob.
 *
 * Validates the structure: exactly 2 keys (`v` + `ct`) where `v === 1`
 * and `ct instanceof Uint8Array`.
 *
 * The key count check (`Object.keys().length === 2`) prevents false positives from
 * user-defined schemas that happen to include `v` and `ct` fields alongside other
 * data. Table rows always have at least 3 keys (`id`, `_v`, plus user fields),
 * so they can never match.
 *
 * @param value - The value to check
 * @returns True if value is a valid EncryptedBlob, false otherwise
 *
 * @example
 * ```typescript
 * const data = JSON.parse(jsonString);
 * if (isEncryptedBlob(data)) {
 *   const decrypted = decryptValue(data, key);
 * }
 * ```
 */
function isEncryptedBlob(value: unknown): value is EncryptedBlob {
	if (typeof value !== 'object' || value === null) return false;
	const obj = value as Record<string, unknown>;
	return (
		Object.keys(obj).length === 2 &&
		obj.v === 1 &&
		obj.ct instanceof Uint8Array
	);
}

/**
 * Derive a 256-bit encryption key from a password using PBKDF2.
 *
 * Uses 600,000 iterations of PBKDF2-SHA256 to derive a key from a password
 * and salt. This is suitable for user-provided passwords and provides
 * resistance against brute-force attacks.
 *
 * @param password - The user's password
 * @param salt - A 16-byte Uint8Array salt (typically derived from userId + workspaceId)
 * @returns A promise that resolves to a 32-byte Uint8Array encryption key
 *
 * @example
 * ```typescript
 * const salt = await deriveSalt('user123', 'workspace456');
 * const key = await deriveKeyFromPassword('myPassword', salt);
 * const encrypted = encryptValue('data', key);
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
 * Second level of a two-level HKDF hierarchy:
 * 1. Server: `HKDF(SHA-256(secret), "user:{userId}:v1")` → per-user key (in session)
 * 2. Client: `HKDF(userKey, "workspace:{workspaceId}:v1")` → per-workspace key (this function)
 *
 * Deterministic — same inputs always produce the same key. No storage needed.
 * Uses Web Crypto `deriveBits` which is available in browser, Cloudflare Workers,
 * and Tauri WebView.
 *
 * @param userKey - A 32-byte Uint8Array user key from the session's encryptionKey
 * @param workspaceId - The workspace identifier (e.g. "tab-manager")
 * @returns A promise that resolves to a 32-byte Uint8Array per-workspace encryption key
 *
 * @example
 * ```typescript
 * const userKey = base64ToBytes(session.encryptionKey);
 * const wsKey = await deriveWorkspaceKey(userKey, 'tab-manager');
 * workspace.unlock(wsKey);
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
			info: new TextEncoder().encode(`workspace:${workspaceId}:v1`),
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
	isEncryptedBlob,
	deriveKeyFromPassword,
	deriveSalt,
	bytesToBase64,
	base64ToBytes,
	deriveWorkspaceKey,
};
