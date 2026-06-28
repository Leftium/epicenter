/**
 * The reducer is the authority boundary, so these tests pin exactly what it
 * lets into the roster and what it drops. Everything is minted with the portable
 * `account/` crypto (no iroh): a fresh 32-byte seed per device, signed via
 * `signAssertion`, so the suite stays browser-safe and matches what a real
 * device would write.
 */

import { describe, expect, test } from 'bun:test';
import type { Assertion, UnsignedAssertion } from './assertion.js';
import { peerIdFromSecret, signAssertion } from './crypto.js';
import { rosterFromAssertions } from './reducer.js';

const ACCOUNT = 'user-1';

/** A deterministic 32-byte seed; `byte` distinguishes devices. */
function seed(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

/** Mint a valid self-signed identity claim for the device holding `secret`. */
function identityClaim(
	secret: Uint8Array,
	options: { account?: string; label: string; seq?: number },
): Assertion {
	const peerId = peerIdFromSecret(secret);
	const unsigned: UnsignedAssertion = {
		account: options.account ?? ACCOUNT,
		asserter: peerId,
		subject: peerId,
		verb: 'identity',
		seq: options.seq ?? 0,
		label: options.label,
	};
	return signAssertion(unsigned, secret);
}

describe('rosterFromAssertions', () => {
	test('a valid self-signed identity claim projects into the roster', () => {
		const secret = seed(1);
		const peerId = peerIdFromSecret(secret);

		const roster = rosterFromAssertions(
			[identityClaim(secret, { label: 'MacBook Pro' })],
			ACCOUNT,
		);

		expect(roster.size).toBe(1);
		expect(roster.get(peerId)).toEqual({ label: 'MacBook Pro' });
	});

	test('an unsigned (tampered-signature) assertion is ignored', () => {
		const secret = seed(2);
		const claim = identityClaim(secret, { label: 'Tampered' });
		// Flip the signature: the bytes no longer verify under the asserter key.
		const forged: Assertion = { ...claim, sig: `${claim.sig.slice(0, -1)}0` };

		expect(rosterFromAssertions([forged], ACCOUNT).size).toBe(0);
	});

	test('an assertion signed by the wrong key is ignored', () => {
		const realSecret = seed(3);
		const attackerSecret = seed(4);
		// Attacker signs, but claims to be the real device (asserter/subject = the
		// victim's peerId). The signature is by the attacker's key, so it fails to
		// verify against the claimed asserter, and never reaches the roster.
		const victimPeerId = peerIdFromSecret(realSecret);
		const forged = signAssertion(
			{
				account: ACCOUNT,
				asserter: victimPeerId,
				subject: victimPeerId,
				verb: 'identity',
				seq: 0,
				label: 'Phishing MacBook',
			},
			attackerSecret,
		);

		expect(rosterFromAssertions([forged], ACCOUNT).size).toBe(0);
	});

	test('a valid assertion for another account is ignored', () => {
		const secret = seed(5);
		const crossAccount = identityClaim(secret, {
			account: 'someone-else',
			label: 'Not ours',
		});

		// Properly signed, but bound to a different account.
		expect(rosterFromAssertions([crossAccount], ACCOUNT).size).toBe(0);
	});

	test('a non-identity verb is ignored in Wave 3 (roster only)', () => {
		const secret = seed(6);
		const peerId = peerIdFromSecret(secret);
		const verifyAssertion = signAssertion(
			{
				account: ACCOUNT,
				asserter: peerId,
				subject: peerIdFromSecret(seed(7)),
				verb: 'verify',
				seq: 0,
			},
			secret,
		);

		expect(rosterFromAssertions([verifyAssertion], ACCOUNT).size).toBe(0);
	});

	test('an identity claim that is not self-signed (asserter != subject) is ignored', () => {
		const secret = seed(8);
		// asserter == the signer, subject == a different peer: not a self-claim, so
		// it cannot mint a roster entry for someone else.
		const notSelf = signAssertion(
			{
				account: ACCOUNT,
				asserter: peerIdFromSecret(secret),
				subject: peerIdFromSecret(seed(9)),
				verb: 'identity',
				seq: 0,
				label: 'Impersonated',
			},
			secret,
		);

		expect(rosterFromAssertions([notSelf], ACCOUNT).size).toBe(0);
	});

	test('a higher-seq re-claim updates the label; a replayed lower seq does not', () => {
		const secret = seed(10);
		const peerId = peerIdFromSecret(secret);
		const original = identityClaim(secret, { label: 'Old name', seq: 0 });
		const renamed = identityClaim(secret, { label: 'New name', seq: 1 });

		// Order-independent: the highest seq wins regardless of array order, since
		// the reducer orders by the asserter's own counter, not Yjs insertion.
		expect(
			rosterFromAssertions([original, renamed], ACCOUNT).get(peerId),
		).toEqual({ label: 'New name' });
		expect(
			rosterFromAssertions([renamed, original], ACCOUNT).get(peerId),
		).toEqual({ label: 'New name' });
	});

	test('two devices each project their own entry', () => {
		const a = seed(11);
		const b = seed(12);
		const roster = rosterFromAssertions(
			[
				identityClaim(a, { label: 'Laptop' }),
				identityClaim(b, { label: 'Phone' }),
			],
			ACCOUNT,
		);

		expect(roster.size).toBe(2);
		expect(roster.get(peerIdFromSecret(a))).toEqual({ label: 'Laptop' });
		expect(roster.get(peerIdFromSecret(b))).toEqual({ label: 'Phone' });
	});

	test('a structurally malformed log entry is ignored, not thrown on', () => {
		const secret = seed(13);
		const roster = rosterFromAssertions(
			[null, 42, { not: 'an assertion' }, identityClaim(secret, { label: 'OK' })],
			ACCOUNT,
		);

		expect(roster.size).toBe(1);
		expect(roster.get(peerIdFromSecret(secret))).toEqual({ label: 'OK' });
	});
});
