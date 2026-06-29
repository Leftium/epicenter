/**
 * The short authentication string (SAS): a deterministic 6-digit code over a
 * pair of iroh public keys, the human side of the `verify` act.
 *
 * Two devices that have never met derive the SAME code from the SAME two
 * peerIds, so a human reads the code off both screens and confirms it matches
 * before either signs a `verify`. The cloud is out of the trust path: it relays
 * the account doc but cannot substitute a key without changing the code, so a
 * relay-swapped key yields a mismatch the human catches. (The other half of the
 * trust path is existing-device approval, where an already-trusted device signs
 * the `verify` directly, with no SAS.)
 *
 * BROWSER-SAFE like the rest of `account/`: the digest is portable
 * `@noble/hashes` sha256 over raw bytes, no `node:crypto` and no iroh, so the
 * same code computes in a browser tab, the daemon, and a future WASM-iroh peer.
 * Ported from the `proto-enroll.ts` SAS (commit d33e338fa3), hardened with the
 * same domain separation the assertion signer uses.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import type { PeerId } from '../peer-transport.js';

/**
 * Domain tag mixed into the SAS digest so a code minted here can never collide
 * with a hash computed over the same two keys for any other Epicenter purpose,
 * and so a future SAS revision is a new domain rather than a silent
 * reinterpretation of the old code.
 */
export const ACCOUNT_SAS_DOMAIN = 'epicenter.account.sas.v1';

/** How many decimal digits the SAS code carries (the modulus is `10 ** this`). */
const SAS_DIGITS = 6;

/**
 * The deterministic 6-digit SAS code for a pair of peers.
 *
 * Order-independent: the two peerIds are sorted before hashing, so both devices
 * derive the same code regardless of who computes it. The digest's first four
 * bytes are read as a big-endian uint32 and reduced modulo `10 ** SAS_DIGITS`,
 * then zero-padded, so the result is always exactly six digits (e.g. `004217`).
 */
export function shortAuthString(a: PeerId, b: PeerId): string {
	const [first, second] = [a, b].sort();
	const canonical = JSON.stringify([ACCOUNT_SAS_DOMAIN, first, second]);
	const digest = sha256(new TextEncoder().encode(canonical));

	// Big-endian uint32 from the first four digest bytes (`>>> 0` keeps it
	// unsigned through the shifts).
	const value =
		((digest[0]! << 24) |
			(digest[1]! << 16) |
			(digest[2]! << 8) |
			digest[3]!) >>>
		0;

	const modulus = 10 ** SAS_DIGITS;
	return String(value % modulus).padStart(SAS_DIGITS, '0');
}
