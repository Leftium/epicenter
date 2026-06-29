/**
 * Portable Ed25519 sign/verify for account-doc assertions.
 *
 * THE BROWSER-SAFETY BOUNDARY. The signature primitive is `@noble/ed25519` over
 * raw 32-byte keys, NOT iroh. iroh stays node-only and transport-only; this
 * module pulls in no native binding, so the reducer that depends on it verifies
 * identically in a browser tab, in the daemon, and in a future WASM-iroh peer.
 *
 * The two key facts that make this work, both proven by direct interop against
 * `@number0/iroh`:
 *   - An iroh `SecretKey.toBytes()` is the standard 32-byte Ed25519 seed, and an
 *     `EndpointId.toString()` (= the `peerId`) is the 64-char lowercase hex of
 *     the 32-byte public key. So `@noble`'s `getPublicKey(seed)` reproduces the
 *     same peerId, and the peerId hex-decodes straight into a verification key.
 *   - A signature `@number0/iroh`'s `SecretKey.sign` produces verifies under
 *     `@noble`'s `verify` against that key, and vice versa. Same curve, same raw
 *     encoding, no adapter.
 *
 * The daemon therefore signs with the bytes of the very iroh key it dials with
 * (one keypair is both identity and signing key, per ADR-0073), but it does so
 * by handing those bytes to {@link signAssertion} here, never by importing iroh
 * into a browser-reachable module.
 *
 * `@noble/ed25519` v3's synchronous API needs a SHA-512 implementation wired in
 * once; we supply `@noble/hashes`' `sha512` at module load so both `sign` and
 * `verify` are available synchronously (the reducer folds the log without
 * awaiting per entry).
 */

import { getPublicKey, hashes, sign, verify } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { asPeerId, type PeerId } from '../peer-transport.js';
import {
	type Assertion,
	assertionSigningBytes,
	type UnsignedAssertion,
} from './assertion.js';

// Wire the synchronous SHA-512 once. `@noble/ed25519` v3 ships no bundled hash
// for its sync path; without this, `sign`/`verify` throw "hashes.sha512 not
// set". Set-once at module load keeps every call site synchronous. The thin
// copy bridges a purely-generic mismatch (`@noble/hashes` types its digest as
// `Uint8Array<ArrayBufferLike>`, `@noble/ed25519` wants `<ArrayBuffer>`); the
// bytes are identical at runtime, proven by direct iroh interop.
hashes.sha512 ??= (message) => Uint8Array.from(sha512(message));

/** The byte length of an Ed25519 public key (a peerId hex-decodes to this). */
const PUBLIC_KEY_BYTES = 32;

/**
 * Derive a peerId (64-hex Ed25519 public key) from a 32-byte secret seed.
 *
 * The daemon passes its iroh `SecretKey.toBytes()`; the result is byte-identical
 * to that key's iroh `EndpointId.toString()`, so the peerId a device signs as is
 * the peerId it dials as.
 */
export function peerIdFromSecret(secretKeyBytes: Uint8Array): PeerId {
	return asPeerId(bytesToHex(getPublicKey(secretKeyBytes)));
}

/**
 * Sign an assertion's core with a 32-byte secret seed, returning the assertion
 * with its `sig` (128-hex) attached. The signature covers exactly
 * {@link assertionSigningBytes}, the domain-separated canonical form.
 */
export function signAssertion(
	unsigned: UnsignedAssertion,
	secretKeyBytes: Uint8Array,
): Assertion {
	const sig = bytesToHex(sign(assertionSigningBytes(unsigned), secretKeyBytes));
	return { ...unsigned, sig };
}

/**
 * Verify an assertion's signature against its own `asserter` key.
 *
 * Returns `true` only when `sig` is a valid Ed25519 signature, by the asserter's
 * key, over this assertion's canonical bytes. A malformed `asserter` (not 32
 * hex bytes), a malformed `sig`, or any tampered field yields `false` rather
 * than throwing, so the reducer can fold an untrusted log without a try/catch
 * per entry. This is the gate that keeps a cloud-injected entry out of every
 * projection.
 */
export function verifyAssertionSignature(assertion: Assertion): boolean {
	const { sig, ...unsigned } = assertion;
	let publicKey: Uint8Array;
	let signature: Uint8Array;
	try {
		publicKey = hexToBytes(unsigned.asserter);
		signature = hexToBytes(sig);
	} catch {
		// Non-hex asserter or signature: not a real assertion, ignore it.
		return false;
	}
	if (publicKey.length !== PUBLIC_KEY_BYTES) return false;
	try {
		return verify(signature, assertionSigningBytes(unsigned), publicKey);
	} catch {
		// `@noble` throws on a structurally invalid signature (wrong length, bad
		// encoding); treat any throw as "does not verify".
		return false;
	}
}
