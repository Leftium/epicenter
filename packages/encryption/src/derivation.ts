import { randomBytes } from '@noble/ciphers/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64 } from './bytes.js';
import { assertEncryptionKeyVersion, type Keyring } from './keys.js';
import type { RootKeyring } from './secrets.js';

const textEncoder = new TextEncoder();
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS_DEFAULT = 600_000;

/**
 * Derive a per-workspace key from a label key.
 *
 * Workspace encryption never uses the label key directly. It derives a
 * workspace-scoped key with HKDF and `workspace:{workspaceId}` as the info
 * label, so the same label key produces independent keys for different
 * workspaces.
 *
 * @example
 * ```typescript
 * const keyBytes = base64ToBytes(session.keyring[0].keyBytesBase64);
 * const workspaceKey = deriveWorkspaceKey(keyBytes, workspaceId);
 * ```
 */
export function deriveWorkspaceKey(
	keyBytes: Uint8Array,
	workspaceId: string,
): Uint8Array {
	return hkdf(
		sha256,
		keyBytes,
		new Uint8Array(0),
		textEncoder.encode(`workspace:${workspaceId}`),
		32,
	);
}

/**
 * Derive a 32-byte key from a password and salt.
 *
 * This helper is for self-managed or local password flows. Cloud API sessions
 * should use `deriveKeyring()` with a root keyring instead.
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
 * Generate a PBKDF2 salt for password-derived keys.
 *
 * This salt is not an encryption nonce. Store it next to the password-derived
 * key metadata so the same password can derive the same key later.
 */
export function generateSalt(): Uint8Array {
	return randomBytes(SALT_LENGTH);
}

/**
 * Wrap raw key bytes in the auth-session keyring shape.
 *
 * Use this when a caller already has key material, such as a password-derived
 * key. Server-side root keyring derivation should call `deriveKeyring()` so
 * every configured root version is included.
 */
export function buildKeyring(
	keyBytes: Uint8Array,
	version: number = 1,
): Keyring {
	assertEncryptionKeyVersion(version);
	return [{ version, keyBytesBase64: bytesToBase64(keyBytes) }];
}

async function deriveLabelKey(
	secret: string,
	label: string,
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
			info: textEncoder.encode(`subject:${label}`),
		},
		hkdfKey,
		256,
	);
	return new Uint8Array(derivedBits);
}

/**
 * Derive a per-label keyring from a root keyring.
 *
 * The API uses this after resolving its root keyring. It returns one
 * `{ version, keyBytesBase64 }` entry per root version, preserving the
 * keyring order supplied by `parseRootKeyring()`.
 *
 * The `label` argument is the caller's partition string (typically an
 * `OwnerId`). The HKDF info bytes are `subject:${label}` and are byte-pinned
 * for backward compatibility with existing keyrings.
 *
 * @example
 * ```typescript
 * const rootKeyring = parseRootKeyring(env.ENCRYPTION_SECRETS);
 * const keyring = await deriveKeyring({
 *   rootKeyring,
 *   label: ownerId,
 * });
 * ```
 */
export async function deriveKeyring({
	rootKeyring,
	label,
}: {
	rootKeyring: RootKeyring;
	label: string;
}): Promise<Keyring> {
	return Promise.all(
		rootKeyring.map(async ({ version, secret }) => ({
			version,
			keyBytesBase64: bytesToBase64(await deriveLabelKey(secret, label)),
		})),
	) as Promise<Keyring>;
}

export { PBKDF2_ITERATIONS_DEFAULT };
