/**
 * attachEncryption tests — fingerprint dedup, key application, key rotation,
 * re-encryption of plaintext, disposal cascade.
 *
 * These tests exercise the attachment directly (without a workspace client)
 * to pin its contract independently of the workspace builder.
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from '@noble/ciphers/utils.js';
import * as Y from 'yjs';
import { bytesToBase64 } from './crypto/index.js';
import { attachEncryption } from './attach-encryption.js';
import { createEncryptedYkvLww } from './y-keyvalue/y-keyvalue-lww-encrypted.js';
import type { EncryptionKeys } from '../workspace/encryption-key.js';

function toEncryptionKeys(key: Uint8Array): EncryptionKeys {
	return [{ version: 1, userKeyBase64: bytesToBase64(key) }];
}

function setup() {
	const ydoc = new Y.Doc({ guid: 'enc-test', gc: false });
	const storeA = createEncryptedYkvLww<{ title: string }>(ydoc, 'a');
	const storeB = createEncryptedYkvLww<{ title: string }>(ydoc, 'b');
	const enc = attachEncryption(ydoc, { stores: [storeA, storeB] as any });
	return { ydoc, storeA, storeB, enc };
}

describe('attachEncryption', () => {
	test('applyKeys enables encrypted writes on every attached store', () => {
		const { storeA, storeB, enc } = setup();
		enc.applyKeys(toEncryptionKeys(randomBytes(32)));
		storeA.set('1', { title: 'Secret A' });
		storeB.set('1', { title: 'Secret B' });
		expect(storeA.get('1')).toEqual({ title: 'Secret A' });
		expect(storeB.get('1')).toEqual({ title: 'Secret B' });
	});

	test('applyKeys is synchronous (returns undefined)', () => {
		const { enc } = setup();
		const result = enc.applyKeys(toEncryptionKeys(randomBytes(32)));
		expect(result).toBeUndefined();
	});

	test('applyKeys re-encrypts existing plaintext entries', () => {
		const { storeA, enc } = setup();
		storeA.set('1', { title: 'Was plaintext' });
		enc.applyKeys(toEncryptionKeys(randomBytes(32)));
		expect(storeA.get('1')).toEqual({ title: 'Was plaintext' });
	});

	test('fingerprint dedup: identical keys short-circuit the second call', () => {
		const { storeA, enc } = setup();
		const key = randomBytes(32);
		enc.applyKeys(toEncryptionKeys(key));
		storeA.set('1', { title: 'Before second apply' });
		// Second call with identical keys must not corrupt state.
		enc.applyKeys(toEncryptionKeys(key));
		expect(storeA.get('1')).toEqual({ title: 'Before second apply' });
	});

	test('fingerprint dedup: reversed key order is treated as the same keyring', () => {
		const { storeA, enc } = setup();
		const keyV1 = randomBytes(32);
		const keyV2 = randomBytes(32);
		const asc: EncryptionKeys = [
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
			{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
		];
		const desc: EncryptionKeys = [
			{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
		];
		enc.applyKeys(asc);
		storeA.set('1', { title: 'Order test' });
		enc.applyKeys(desc);
		expect(storeA.get('1')).toEqual({ title: 'Order test' });
	});

	test('key rotation: data written with old key remains readable after rotation', () => {
		const { storeA, enc } = setup();
		const keyV1 = randomBytes(32);
		const keyV2 = randomBytes(32);

		enc.applyKeys([{ version: 1, userKeyBase64: bytesToBase64(keyV1) }]);
		storeA.set('old', { title: 'Written with v1' });

		enc.applyKeys([
			{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
			{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
		]);

		expect(storeA.get('old')).toEqual({ title: 'Written with v1' });

		storeA.set('new', { title: 'Written with v2' });
		expect(storeA.get('new')).toEqual({ title: 'Written with v2' });
	});

	test('plaintext writes are readable before applyKeys is called', () => {
		const { storeA } = setup();
		storeA.set('1', { title: 'Plaintext' });
		expect(storeA.get('1')).toEqual({ title: 'Plaintext' });
	});

	test('clearLocalData wipes every store in a single transaction', () => {
		const { ydoc, storeA, storeB, enc } = setup();
		storeA.set('1', { title: 'a1' });
		storeA.set('2', { title: 'a2' });
		storeB.set('1', { title: 'b1' });

		let observedTransactions = 0;
		ydoc.on('afterTransaction', () => {
			observedTransactions++;
		});

		enc.clearLocalData();

		expect(storeA.get('1')).toBeUndefined();
		expect(storeA.get('2')).toBeUndefined();
		expect(storeB.get('1')).toBeUndefined();
		// One combined transaction, not one per store.
		expect(observedTransactions).toBe(1);
	});

	test('whenDisposed resolves once ydoc.destroy() fires', async () => {
		const { ydoc, enc } = setup();
		ydoc.destroy();
		await enc.whenDisposed;
	});

	test('stores is the same array the caller provided', () => {
		const { storeA, storeB, enc } = setup();
		expect(enc.stores).toEqual([storeA, storeB]);
	});
});
