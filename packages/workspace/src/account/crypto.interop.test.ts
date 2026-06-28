/**
 * The load-bearing interop contract: the portable `account/` crypto and
 * `@number0/iroh` agree on the SAME raw Ed25519 keys.
 *
 * The whole browser-safety design rests on this. The reducer verifies signatures
 * with portable `@noble/ed25519` over raw key bytes, while the daemon's identity
 * and signing key is an iroh `SecretKey`. If those two libraries ever disagreed
 * on the key/seed/signature encoding, a daemon-signed identity claim would be
 * silently dropped by every browser reducer. This test imports iroh (node-only,
 * like `gateway.test.ts`) to pin the contract so a future `@noble` or iroh
 * upgrade that broke it fails here, loudly, instead of in production.
 */

import { describe, expect, test } from 'bun:test';
import { SecretKey } from '@number0/iroh';
import type { UnsignedAssertion } from './assertion.js';
import {
	peerIdFromSecret,
	signAssertion,
	verifyAssertionSignature,
} from './crypto.js';

describe('account crypto <-> iroh interop', () => {
	test('a peerId is the iroh public key in 64-hex, derivable portably', () => {
		const secret = SecretKey.generate();
		const secretBytes = Uint8Array.from(secret.toBytes());

		// iroh's EndpointId.toString() and the portable derivation agree.
		expect(String(peerIdFromSecret(secretBytes))).toBe(
			secret.public().toString(),
		);
	});

	test('the portable verifier accepts an assertion signed with iroh key bytes', () => {
		const secret = SecretKey.generate();
		const secretBytes = Uint8Array.from(secret.toBytes());
		const peerId = peerIdFromSecret(secretBytes);

		const unsigned: UnsignedAssertion = {
			account: 'user-1',
			asserter: peerId,
			subject: peerId,
			verb: 'identity',
			seq: 0,
			label: 'MacBook Pro',
		};

		// Sign with the bytes of a real iroh key; verify with the portable path.
		const assertion = signAssertion(unsigned, secretBytes);
		expect(verifyAssertionSignature(assertion)).toBe(true);

		// Any tampered field breaks verification.
		expect(
			verifyAssertionSignature({ ...assertion, label: 'Phishing' }),
		).toBe(false);
	});
});
