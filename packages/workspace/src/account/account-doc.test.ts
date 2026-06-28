/**
 * The append path against a real `Y.Doc` (no relay, no iroh): proves the
 * idempotent self-claim and that two devices writing to the same doc each get a
 * roster entry. The Y.Array is the real CRDT structure a synced account doc
 * would carry, so these exercise the exact reads/writes the daemon performs.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	accountAssertionLog,
	appendIdentityClaim,
	appendRevoke,
	appendVerify,
	readAssertions,
	readRoster,
} from './account-doc.js';
import { peerIdFromSecret, signAssertion } from './crypto.js';
import { asPeerId } from '../gateway/transport.js';
import { trustFromAssertions } from './reducer.js';

const ACCOUNT = 'user-1';

function seed(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

describe('appendIdentityClaim', () => {
	test('appends a self-claim and lists the device in the roster', () => {
		const ydoc = new Y.Doc();
		const secret = seed(1);

		const result = appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: secret,
			label: 'Workstation',
		});

		expect(result.appended).toBe(true);
		expect(result.peerId).toBe(peerIdFromSecret(secret));
		expect(accountAssertionLog(ydoc).length).toBe(1);
		expect(readRoster(ydoc, ACCOUNT).get(result.peerId)).toEqual({
			label: 'Workstation',
		});
	});

	test('is idempotent: re-claiming the same label appends nothing', () => {
		const ydoc = new Y.Doc();
		const secret = seed(2);
		const claim = () =>
			appendIdentityClaim({
				ydoc,
				account: ACCOUNT,
				secretKeyBytes: secret,
				label: 'Workstation',
			});

		expect(claim().appended).toBe(true);
		expect(claim().appended).toBe(false);
		expect(claim().appended).toBe(false);
		expect(accountAssertionLog(ydoc).length).toBe(1);
	});

	test('a renamed label appends a fresh, higher-seq claim that supersedes', () => {
		const ydoc = new Y.Doc();
		const secret = seed(3);
		const peerId = peerIdFromSecret(secret);

		appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: secret,
			label: 'Old',
		});
		const renamed = appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: secret,
			label: 'New',
		});

		expect(renamed.appended).toBe(true);
		expect(accountAssertionLog(ydoc).length).toBe(2);
		// The reducer folds both claims; the higher-seq rename wins.
		expect(readRoster(ydoc, ACCOUNT).get(peerId)).toEqual({ label: 'New' });
		// The second claim carries the next seq.
		const seqs = accountAssertionLog(ydoc)
			.toArray()
			.map((a) => a.seq);
		expect(seqs).toEqual([0, 1]);
	});

	test('a forged high-seq entry in the device name does not bump its next seq', () => {
		const ydoc = new Y.Doc();
		const secret = seed(6);
		const attacker = seed(7);
		const peerId = peerIdFromSecret(secret);

		// The device makes one real claim at seq 0.
		appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: secret,
			label: 'Real',
		});

		// The relay injects a claim in the device's NAME at a high seq, signed by
		// an attacker key (it has no device key). It fails the device's own
		// signature check, so it must not advance the device's counter.
		accountAssertionLog(ydoc).push([
			signAssertion(
				{
					account: ACCOUNT,
					asserter: peerId,
					subject: peerId,
					verb: 'identity',
					seq: 99,
					label: 'Injected',
				},
				attacker,
			),
		]);

		// The next genuine rename must be seq 1 (real 0 + 1), NOT 100.
		appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: secret,
			label: 'Renamed',
		});

		const ownSeqs = accountAssertionLog(ydoc)
			.toArray()
			.filter((a) => a.asserter === peerId && a.label === 'Renamed')
			.map((a) => a.seq);
		expect(ownSeqs).toEqual([1]);
		// The injected entry never reaches the roster, and the real rename wins.
		expect(readRoster(ydoc, ACCOUNT).get(peerId)).toEqual({ label: 'Renamed' });
	});

	test('re-asserting heals a stale local seq once a higher-seq own claim merges', () => {
		// Models the git-clean case: the device key survived but the local log was
		// wiped, so the device first announced at a low seq; then the cloud
		// delivered this device's OWN older, higher-seq claim. Re-asserting (what
		// open-account-room does on sync) must supersede it, not stay shadowed.
		const ydoc = new Y.Doc();
		const secret = seed(8);
		const peerId = peerIdFromSecret(secret);

		// Fresh device announces "New" at seq 0 (stale local log).
		appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: secret,
			label: 'New',
		});

		// The cloud merges this device's own prior seq-5 claim with the old label.
		accountAssertionLog(ydoc).push([
			signAssertion(
				{
					account: ACCOUNT,
					asserter: peerId,
					subject: peerId,
					verb: 'identity',
					seq: 5,
					label: 'Old',
				},
				secret,
			),
		]);
		// Without healing, highest-seq-wins would pin the OLD label.
		expect(readRoster(ydoc, ACCOUNT).get(peerId)).toEqual({ label: 'Old' });

		// Re-assert: writes seq 6 with the desired label, reclaiming the roster.
		const healed = appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: secret,
			label: 'New',
		});
		expect(healed.appended).toBe(true);
		expect(readRoster(ydoc, ACCOUNT).get(peerId)).toEqual({ label: 'New' });
	});

	test('two devices on one doc each list themselves', () => {
		const ydoc = new Y.Doc();
		const a = seed(4);
		const b = seed(5);

		appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: a,
			label: 'Laptop',
		});
		appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: b,
			label: 'Phone',
		});

		const roster = readRoster(ydoc, ACCOUNT);
		expect(roster.size).toBe(2);
		expect(roster.get(peerIdFromSecret(a))).toEqual({ label: 'Laptop' });
		expect(roster.get(peerIdFromSecret(b))).toEqual({ label: 'Phone' });
	});
});

describe('appendVerify / appendRevoke', () => {
	test('a written verify reads `verified` under the asserter-rooted reducer', () => {
		const ydoc = new Y.Doc();
		const self = seed(10);
		const target = seed(11);
		const selfPeerId = peerIdFromSecret(self);
		const subject = peerIdFromSecret(target);

		const result = appendVerify({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: self,
			subject,
		});

		expect(result.asserter).toBe(selfPeerId);
		expect(result.subject).toBe(subject);
		expect(accountAssertionLog(ydoc).length).toBe(1);
		// Rooted in self's key, its own verify confers `verified` on the subject.
		const trust = trustFromAssertions(readAssertions(ydoc), ACCOUNT, selfPeerId);
		expect(trust.get(subject)).toBe('verified');
	});

	test('a written revoke reads `revoked`, and supersedes a prior verify', () => {
		const ydoc = new Y.Doc();
		const self = seed(12);
		const target = seed(13);
		const selfPeerId = peerIdFromSecret(self);
		const subject = peerIdFromSecret(target);

		appendVerify({ ydoc, account: ACCOUNT, secretKeyBytes: self, subject });
		const revoked = appendRevoke({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: self,
			subject,
		});

		// The verdict counter is per-asserter and spans verbs: verify=0, revoke=1.
		expect(revoked.seq).toBe(1);
		const trust = trustFromAssertions(readAssertions(ydoc), ACCOUNT, selfPeerId);
		expect(trust.get(subject)).toBe('revoked');
	});

	test('verdict seq shares the per-asserter counter with identity claims', () => {
		const ydoc = new Y.Doc();
		const self = seed(14);
		const subject = asPeerId(peerIdFromSecret(seed(15)));

		// identity at seq 0, then the first verdict must be seq 1 (one counter).
		appendIdentityClaim({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: self,
			label: 'Workstation',
		});
		const verify = appendVerify({
			ydoc,
			account: ACCOUNT,
			secretKeyBytes: self,
			subject,
		});
		expect(verify.seq).toBe(1);
	});
});
