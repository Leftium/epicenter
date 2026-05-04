import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from '@noble/ciphers/utils.js';
import type { Brand } from 'wellcrafted/brand';
import { assertEncryptionKeyVersion } from './keys.js';

const NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 2;
const MINIMUM_BLOB_SIZE = HEADER_LENGTH + NONCE_LENGTH + TAG_LENGTH;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Binary encrypted value stored directly in Yjs.
 *
 * The format is fixed-width header plus variable ciphertext:
 * byte 0 is format version `1`, byte 1 is key version, bytes 2 through 25 are
 * the XChaCha20 nonce, and the remaining bytes are ciphertext plus tag.
 */
export type EncryptedBlob = Uint8Array & Brand<'EncryptedBlob'>;

/**
 * Encrypt a plaintext string into the current binary blob format.
 *
 * The key must already be scoped to the storage context, for example via
 * `deriveWorkspaceKey()`. `aad` binds the ciphertext to caller-owned context
 * such as an entry key, preventing a valid blob from being moved to a different
 * logical slot without detection.
 *
 * @example
 * ```typescript
 * const aad = new TextEncoder().encode(entryKey);
 * const blob = encryptValue(JSON.stringify(value), workspaceKey, aad, 2);
 * ```
 */
export function encryptValue(
	plaintext: string,
	key: Uint8Array,
	aad?: Uint8Array,
	keyVersion: number = 1,
): EncryptedBlob {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
	assertEncryptionKeyVersion(keyVersion);
	const nonce = randomBytes(NONCE_LENGTH);
	const cipher = aad
		? xchacha20poly1305(key, nonce, aad)
		: xchacha20poly1305(key, nonce);
	const data = textEncoder.encode(plaintext);
	const ciphertext = cipher.encrypt(data);

	const packed = new Uint8Array(
		HEADER_LENGTH + nonce.length + ciphertext.length,
	);
	packed[0] = 1;
	packed[1] = keyVersion;
	packed.set(nonce, HEADER_LENGTH);
	packed.set(ciphertext, HEADER_LENGTH + nonce.length);

	return packed as EncryptedBlob;
}

/**
 * Decrypt an `EncryptedBlob` with the selected key.
 *
 * This function validates the blob format byte, but it does not choose a key
 * from a keyring. Call `getKeyVersion()` first when decrypting rotated data so
 * the caller can select the key matching byte 1.
 */
export function decryptValue(
	blob: EncryptedBlob,
	key: Uint8Array,
	aad?: Uint8Array,
): string {
	if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
	const formatVersion = blob[0];
	if (formatVersion !== 1) {
		throw new Error(
			`Unknown encryption format version: ${formatVersion}. This blob may require a newer client.`,
		);
	}

	const nonce = blob.slice(HEADER_LENGTH, HEADER_LENGTH + NONCE_LENGTH);
	const ciphertext = blob.slice(HEADER_LENGTH + NONCE_LENGTH);
	const cipher = aad
		? xchacha20poly1305(key, nonce, aad)
		: xchacha20poly1305(key, nonce);
	const data = cipher.decrypt(ciphertext);

	return textDecoder.decode(data);
}

/**
 * Read the key version from blob byte 1 without decrypting.
 *
 * Workspace storage uses this to select the right key from a rotated keyring
 * before calling `decryptValue()`.
 */
export function getKeyVersion(blob: EncryptedBlob): number {
	return blob[1] as number;
}

/**
 * Detect values written by the current encrypted blob format.
 *
 * User values are plain JSON-shaped data, not byte arrays, so this guard is the
 * boundary between plaintext values and encrypted storage values inside the Yjs
 * wrapper.
 */
export function isEncryptedBlob(value: unknown): value is EncryptedBlob {
	return (
		value instanceof Uint8Array &&
		value.length >= MINIMUM_BLOB_SIZE &&
		value[0] === 1
	);
}
