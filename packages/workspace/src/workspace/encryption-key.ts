/**
 * ArkType schema for versioned encryption keys in transit.
 *
 * This is the **source of truth** for the `EncryptionKey` shape. The TypeScript
 * type is derived from the schema via `typeof EncryptionKey.infer`, so runtime
 * validation and static types are always in sync.
 *
 * Used by:
 * - Session response (`encryptionKeys` field)
 * - `workspace.encryption.unlock(keys)`
 * - `UserKeyStore` cache deserialization (runtime validation)
 *
 * @module
 */
import { type } from 'arktype';

/**
 * A single versioned encryption key for transport.
 *
 * Pairs a key version (from the server's `ENCRYPTION_SECRETS`) with the
 * HKDF-derived per-user key encoded as base64 for JSON transport.
 */
export const EncryptionKey = type({
	version: 'number.integer > 0',
	userKeyBase64: 'string',
});

/**
 * Non-empty array of versioned encryption keys.
 *
 * Guarantees at least one key is present. The highest-version entry is the
 * current key for new encryptions; older entries exist for decrypting blobs
 * encrypted with previous key versions.
 */
export const EncryptionKeys = type([
	EncryptionKey,
	'...',
	EncryptionKey.array(),
]);
export type EncryptionKey = typeof EncryptionKey.infer;
export type EncryptionKeys = typeof EncryptionKeys.infer;
