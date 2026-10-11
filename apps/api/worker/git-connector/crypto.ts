/**
 * Web Crypto helpers for the GitHub connector: random secrets, stored secret
 * hashes, PKCE S256, and AES-GCM sealing of provider tokens. Every function
 * uses APIs available in both Workers and Bun.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
	const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** 32 random bytes as 43 base64url characters. */
export function randomSecret(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(text: string): Promise<Uint8Array> {
	return new Uint8Array(
		await crypto.subtle.digest('SHA-256', encoder.encode(text)),
	);
}

/** The stored form of a high-entropy secret. */
export async function hashSecret(secret: string): Promise<string> {
	return base64url(await sha256(secret));
}

/**
 * Compare a presented secret against its stored hash without an early exit.
 * Both sides are fixed-length digests, so timing does not depend on how many
 * leading characters of the presented secret match.
 */
export async function secretMatches(
	presented: string,
	storedHash: string,
): Promise<boolean> {
	const actual = await sha256(presented);
	const expected = fromBase64url(storedHash);
	if (expected.length !== actual.length) return false;
	let difference = 0;
	for (let i = 0; i < actual.length; i++)
		difference |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
	return difference === 0;
}

/** RFC 7636 S256 code challenge for a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
	return base64url(await sha256(verifier));
}

/**
 * Import `GIT_GRANT_ENCRYPTION_KEY` (standard or URL-safe base64 of exactly 32 bytes)
 * as a non-extractable AES-GCM key. Returns undefined for anything else, so a
 * malformed key reads as missing configuration rather than a weaker key.
 */
export async function importSealKey(
	encoded: string | undefined,
): Promise<CryptoKey | undefined> {
	if (!encoded) return undefined;
	let raw: Uint8Array<ArrayBuffer>;
	try {
		raw = fromBase64url(encoded.trim());
	} catch {
		return undefined;
	}
	if (raw.length !== 32) return undefined;
	return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
		'encrypt',
		'decrypt',
	]);
}

/**
 * Encrypt a JSON value with AES-GCM. `context` is authenticated additional
 * data, so a ciphertext copied into another connection's record fails to open.
 */
export async function seal(
	key: CryptoKey,
	context: string,
	value: unknown,
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(context) },
		key,
		encoder.encode(JSON.stringify(value)),
	);
	return `${base64url(iv)}.${base64url(new Uint8Array(ciphertext))}`;
}

/** Decrypt a value sealed by {@link seal}; undefined when it fails to open. */
export async function unseal<T>(
	key: CryptoKey,
	context: string,
	sealed: string,
): Promise<T | undefined> {
	const [iv, ciphertext] = sealed.split('.');
	if (!iv || !ciphertext) return undefined;
	try {
		const plaintext = await crypto.subtle.decrypt(
			{
				name: 'AES-GCM',
				iv: fromBase64url(iv),
				additionalData: encoder.encode(context),
			},
			key,
			fromBase64url(ciphertext),
		);
		return JSON.parse(decoder.decode(plaintext)) as T;
	} catch {
		return undefined;
	}
}
