import { type } from 'arktype';

/**
 * Transport-safe per-user encryption key delivered through auth sessions.
 *
 * The version is capped at 255 because encrypted blobs store the key version
 * in a single byte. `userKeyBase64` is actual key material, not a fingerprint
 * or public identifier, so callers should treat values matching this schema as
 * secrets.
 */
export const EncryptionKey = type({
	version: '1 <= number.integer <= 255',
	userKeyBase64: 'string',
});

/**
 * Non-empty keyring of user encryption keys.
 *
 * New writes use the highest version after workspace activation. Older entries
 * stay in the keyring so existing blobs can be decrypted and lazily upgraded.
 */
export const EncryptionKeys = type([
	EncryptionKey,
	'...',
	EncryptionKey.array(),
]);

export type EncryptionKey = typeof EncryptionKey.infer;
export type EncryptionKeys = typeof EncryptionKeys.infer;

/**
 * Reject versions that cannot be represented in the encrypted blob header.
 *
 * Blob byte 1 stores the key version. Validating this at public entry points
 * prevents silent truncation before a value reaches storage.
 */
export function assertEncryptionKeyVersion(version: number): void {
	if (!Number.isInteger(version) || version < 1 || version > 255) {
		throw new Error('Encryption key version must be an integer from 1 to 255');
	}
}

/**
 * Compare two encryption keyrings without creating a secret-bearing string.
 *
 * This is intentionally structural and order-independent. Use it for cache or
 * state dedup checks where the old `fingerprint` helper was tempting, but do
 * not log either input because both contain live key material.
 *
 * @example
 * ```typescript
 * if (!encryptionKeysEqual(nextKeys, currentKeys)) {
 *   workspace.encryption.applyKeys(nextKeys);
 * }
 * ```
 */
export function encryptionKeysEqual(
	left: EncryptionKeys,
	right: EncryptionKeys,
): boolean {
	if (left.length !== right.length) return false;
	const sortedLeft = [...left].sort((a, b) => a.version - b.version);
	const sortedRight = [...right].sort((a, b) => a.version - b.version);
	return sortedLeft.every((leftKey, index) => {
		const rightKey = sortedRight[index];
		return (
			rightKey !== undefined &&
			leftKey.version === rightKey.version &&
			leftKey.userKeyBase64 === rightKey.userKeyBase64
		);
	});
}
