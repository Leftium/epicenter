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
	readRoster,
} from './account-doc.js';
import { peerIdFromSecret } from './crypto.js';

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
