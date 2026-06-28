/**
 * The SAS is the human's eyes on the trust path, so these pin the two properties
 * a human relies on: both devices derive the SAME code from the same pair (so a
 * match means agreement), and a different pair derives a different code (so a
 * relay-swapped key is caught). Keys are minted with the portable `account/`
 * crypto, no iroh, like the rest of the suite.
 */

import { describe, expect, test } from 'bun:test';
import { peerIdFromSecret } from './crypto.js';
import { shortAuthString } from './sas.js';

/** A deterministic peerId for device `byte`. */
function peer(byte: number) {
	return peerIdFromSecret(new Uint8Array(32).fill(byte));
}

describe('shortAuthString', () => {
	test('is always a 6-digit decimal string', () => {
		const code = shortAuthString(peer(1), peer(2));
		expect(code).toMatch(/^\d{6}$/);
	});

	test('is order-independent: both devices derive the same code', () => {
		const a = peer(3);
		const b = peer(4);
		expect(shortAuthString(a, b)).toBe(shortAuthString(b, a));
	});

	test('a different pair derives a different code', () => {
		// A relay that substitutes one key changes the code, so the human catches
		// the swap. (Distinct seeds, overwhelmingly unlikely to collide in 6 digits.)
		expect(shortAuthString(peer(5), peer(6))).not.toBe(
			shortAuthString(peer(5), peer(7)),
		);
	});

	test('is deterministic across calls', () => {
		expect(shortAuthString(peer(8), peer(9))).toBe(
			shortAuthString(peer(8), peer(9)),
		);
	});
});
