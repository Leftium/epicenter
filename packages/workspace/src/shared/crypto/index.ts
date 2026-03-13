import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';

/**
 * Encrypted blob format for persisted and synced encrypted data.
 *
 * Uses AES-256-GCM with a 12-byte nonce and 16-byte authentication tag.
 * Field names are compact (`ct`, `iv`, `v`, `alg`) because this type is
 * persisted in the workspace database and synced across clients.
 *
 * @example
 * ```typescript
 * const encrypted: EncryptedBlob = {
 *   v: 1,
 *   alg: 'A256GCM',
 *   ct: 'base64-encoded-ciphertext',
 *   iv: 'base64-encoded-nonce',
 * };
 * ```
 */
type EncryptedBlob = {
	v: 1;
	alg: 'A256GCM';
	ct: string;
	iv: string;
};

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
 * The nonce and ciphertext are returned as base64-encoded strings for easy storage
 * and transmission.
 *
 * @param plaintext - The string to encrypt
 * @param key - A 32-byte Uint8Array encryption key
 * @returns An EncryptedBlob with base64-encoded ciphertext and nonce
 *
 * @example
 * ```typescript
 * const key = generateEncryptionKey();
 * const encrypted = encryptValue('secret data', key);
 * console.log(encrypted);
 * // { v: 1, alg: 'A256GCM', ct: '...', iv: '...' }
 * ```
 */
function encryptValue(plaintext: string, key: Uint8Array): EncryptedBlob {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (AES-256)');
	const nonce = randomBytes(12);
	const cipher = gcm(key, nonce);
	const data = new TextEncoder().encode(plaintext);
	const ciphertext = cipher.encrypt(data);

	return {
		v: 1,
		alg: 'A256GCM',
		ct: bytesToBase64(ciphertext),
		iv: bytesToBase64(nonce),
	};
}

/**
 * Decrypt an EncryptedBlob using AES-256-GCM.
 *
 * Decodes the base64-encoded ciphertext and nonce from the blob, then decrypts
 * using the provided key. Throws if the authentication tag is invalid or if
 * decryption fails.
 *
 * @param blob - An EncryptedBlob with base64-encoded ciphertext and nonce
 * @param key - The 32-byte Uint8Array encryption key used to encrypt the blob
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
function decryptValue(blob: EncryptedBlob, key: Uint8Array): string {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes (AES-256)');
	const ciphertext = base64ToBytes(blob.ct);
	const nonce = base64ToBytes(blob.iv);
	const cipher = gcm(key, nonce);
	const data = cipher.decrypt(ciphertext);

	return new TextDecoder().decode(data);
}

/**
 * Type guard to check if a value is a valid EncryptedBlob.
 *
 * Validates the structure and field types of an EncryptedBlob without
 * performing cryptographic verification. Use this to safely narrow types
 * when deserializing data from storage or network.
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
	return (
		typeof value === 'object' &&
		value !== null &&
		'v' in value &&
		'alg' in value &&
		'ct' in value &&
		'iv' in value &&
		(value as Record<string, unknown>).v === 1 &&
		(value as Record<string, unknown>).alg === 'A256GCM' &&
		typeof (value as Record<string, unknown>).ct === 'string' &&
		typeof (value as Record<string, unknown>).iv === 'string'
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
};
