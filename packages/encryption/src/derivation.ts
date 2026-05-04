import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64 } from './bytes.js';
import { assertEncryptionKeyVersion, type EncryptionKeys } from './keys.js';
import type { EncryptionSecrets } from './secrets.js';

const textEncoder = new TextEncoder();
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS_DEFAULT = 600_000;

/**
 * Derive a per-workspace key from a per-user key.
 *
 * Workspace encryption never uses the session key directly. It derives a
 * workspace-scoped key with HKDF and `workspace:{workspaceId}` as the info
 * label, so the same user key produces independent keys for different
 * workspaces.
 *
 * @example
 * ```typescript
 * const userKey = base64ToBytes(session.encryptionKeys[0].userKeyBase64);
 * const workspaceKey = deriveWorkspaceKey(userKey, workspaceId);
 * ```
 */
export function deriveWorkspaceKey(
	userKey: Uint8Array,
	workspaceId: string,
): Uint8Array {
	return hkdf(
		sha256,
		userKey,
		new Uint8Array(0),
		textEncoder.encode(`workspace:${workspaceId}`),
		32,
	);
}

/**
 * Derive a 32-byte user key from a password and salt.
 *
 * This helper is for self-managed or local password flows. Cloud API sessions
 * should use `deriveUserEncryptionKeys()` with deployment secrets instead.
 */
export function deriveKeyFromPassword(
	password: string,
	salt: Uint8Array,
	iterations: number = PBKDF2_ITERATIONS_DEFAULT,
): Uint8Array {
	return pbkdf2(sha256, textEncoder.encode(password), salt, {
		c: iterations,
		dkLen: 32,
	});
}

/**
 * Generate a PBKDF2 salt for password-derived user keys.
 *
 * This salt is not an encryption nonce. Store it next to the password-derived
 * key metadata so the same password can derive the same user key later.
 */
export function generateSalt(): Uint8Array {
	return randomBytes(SALT_LENGTH);
}

/**
 * Wrap raw user key bytes in the auth-session keyring shape.
 *
 * Use this when a caller already has a user key, such as a password-derived
 * key. Server-side deployment derivation should call
 * `deriveUserEncryptionKeys()` so every configured secret version is included.
 */
export function buildEncryptionKeys(
	userKey: Uint8Array,
	version: number = 1,
): EncryptionKeys {
	assertEncryptionKeyVersion(version);
	return [{ version, userKeyBase64: bytesToBase64(userKey) }];
}

async function deriveUserKey(
	secret: string,
	userId: string,
): Promise<Uint8Array> {
	const rawKey = await crypto.subtle.digest(
		'SHA-256',
		textEncoder.encode(secret),
	);
	const hkdfKey = await crypto.subtle.importKey('raw', rawKey, 'HKDF', false, [
		'deriveBits',
	]);
	const derivedBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: new Uint8Array(0),
			info: textEncoder.encode(`user:${userId}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

/**
 * Derive per-user transport keys from deployment encryption secrets.
 *
 * The API uses this after parsing `ENCRYPTION_SECRETS`. It returns one
 * `{ version, userKeyBase64 }` entry per secret version, preserving the
 * keyring order supplied by `parseEncryptionSecrets()`.
 *
 * @example
 * ```typescript
 * const secrets = parseEncryptionSecrets(env.ENCRYPTION_SECRETS);
 * const encryptionKeys = await deriveUserEncryptionKeys({
 *   secrets,
 *   userId: user.id,
 * });
 * ```
 */
export async function deriveUserEncryptionKeys({
	secrets,
	userId,
}: {
	secrets: EncryptionSecrets;
	userId: string;
}): Promise<EncryptionKeys> {
	return Promise.all(
		secrets.map(async ({ version, secret }) => ({
			version,
			userKeyBase64: bytesToBase64(await deriveUserKey(secret, userId)),
		})),
	) as Promise<EncryptionKeys>;
}

export { PBKDF2_ITERATIONS_DEFAULT };
