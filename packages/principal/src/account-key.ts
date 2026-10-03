import type { AccountIdentity } from './principal.js';

/** A portable account directory name: all 32 SHA-256 bytes as lowercase hex. */
export function isAccountKey(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Name of the `accounts/` child that holds one account's portable data folders
 * (ADR-0461). The result is a permanent path contract:
 *
 * ```text
 * lowercase_hex(SHA-256(U32BE(byte_length(A)) || A || P))
 * ```
 *
 * `A` and `P` are the exact UTF-8 bytes of `authorityId` and `principalId`.
 * Nothing is trimmed, case folded, or Unicode normalized, so two identities
 * that differ in any byte select different directories.
 *
 * Private device storage keeps using `deviceOwnerPath`; that reversible address
 * is not a portable directory name.
 */
export async function accountKey({
	authorityId,
	principalId,
}: AccountIdentity): Promise<string> {
	for (const value of [authorityId, principalId]) {
		if (
			typeof value !== 'string' ||
			value.length === 0 ||
			!value.isWellFormed() ||
			/[\p{Cc}]/u.test(value)
		)
			throw new TypeError('Invalid portable account identity.');
	}
	const encoder = new TextEncoder();
	const authority = encoder.encode(authorityId);
	if (authority.length > 0xffff_ffff)
		throw new TypeError('Invalid portable account identity.');
	const principal = encoder.encode(principalId);
	const input = new Uint8Array(4 + authority.length + principal.length);
	new DataView(input.buffer).setUint32(0, authority.length);
	input.set(authority, 4);
	input.set(principal, 4 + authority.length);
	const digest = await crypto.subtle.digest('SHA-256', input);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
}
