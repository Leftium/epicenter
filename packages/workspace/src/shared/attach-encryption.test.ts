/**
 * attachEncryption tests — registration, fingerprint dedup, key application,
 * key rotation, re-encryption of plaintext, late-register auto-activation,
 * disposal cascade, reentrance guard.
 *
 * These tests exercise the attachment directly (without a workspace client)
 * to pin its contract independently of the workspace builder. Stores are
 * constructed with `createEncryptedYkvLww` and registered via
 * `encryption.register(store)` — the same pathway used by
 * `attachEncryptedTable` / `attachEncryptedKv`.
 */

import { describe, expect, test } from 'bun:test';
import { randomBytes } from '@noble/ciphers/utils.js';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachTable } from '@epicenter/document';
import { attachEncryption } from './attach-encryption.js';
import { bytesToBase64 } from './crypto/index.js';
import { createEncryptedYkvLww } from './y-keyvalue/y-keyvalue-lww-encrypted.js';
import { attachEncryptedKv } from '../workspace/attach-kv.js';
import { attachEncryptedTable } from '../workspace/attach-tables.js';
import { defineKv } from '../workspace/define-kv.js';
import { defineTable } from '../workspace/define-table.js';
import type { EncryptionKeys } from '../workspace/encryption-key.js';

function toEncryptionKeys(key: Uint8Array): EncryptionKeys {
	return [{ version: 1, userKeyBase64: bytesToBase64(key) }];
}

function setup() {
	const ydoc = new Y.Doc({ guid: 'enc-test', gc: false });
	const enc = attachEncryption(ydoc);
	const storeA = createEncryptedYkvLww<{ title: string }>(ydoc, 'a');
	const storeB = createEncryptedYkvLww<{ title: string }>(ydoc, 'b');
	enc.register(storeA);
	enc.register(storeB);
	return { ydoc, storeA, storeB, enc };
}

describe('attachEncryption', () => {
	test('applyKeys enables encrypted writes on every registered store', () => {
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

	test('late-registered store auto-activates with cached keyring', () => {
		const ydoc = new Y.Doc({ guid: 'enc-late-register', gc: false });
		const enc = attachEncryption(ydoc);
		enc.applyKeys(toEncryptionKeys(randomBytes(32)));

		// Register after applyKeys — the store must receive the cached keyring
		// so subsequent writes are encrypted from the start.
		const lateStore = createEncryptedYkvLww<{ title: string }>(ydoc, 'late');
		enc.register(lateStore);

		lateStore.set('1', { title: 'Written after late register' });
		expect(lateStore.get('1')).toEqual({ title: 'Written after late register' });
	});

	test('whenDisposed resolves once ydoc.destroy() fires', async () => {
		const { ydoc, enc } = setup();
		ydoc.destroy();
		await enc.whenDisposed;
	});
});

describe('attachEncryption.assertAllStoresRegistered', () => {
	const tableDef = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
	const kvDef = {
		flag: defineKv(type({ on: 'boolean' }), { on: false }),
	};

	test('passes when every encryption-capable slot is registered', () => {
		const ydoc = new Y.Doc({ guid: 'assert-ok', gc: false });
		const enc = attachEncryption(ydoc);
		attachEncryptedTable(ydoc, enc, 'posts', tableDef);
		attachEncryptedKv(ydoc, enc, kvDef);

		expect(() => enc.assertAllStoresRegistered(ydoc)).not.toThrow();
	});

	test('throws when a table was attached with the plaintext primitive', () => {
		const ydoc = new Y.Doc({ guid: 'assert-plaintext-table', gc: false });
		const enc = attachEncryption(ydoc);
		attachEncryptedTable(ydoc, enc, 'posts', tableDef);
		// Accident: plaintext primitive used for a slot that should be encrypted.
		attachTable(ydoc, 'secrets', tableDef);

		expect(() => enc.assertAllStoresRegistered(ydoc)).toThrow(
			/table:secrets/,
		);
	});

	test('allowPlaintext opts a slot out of the check', () => {
		const ydoc = new Y.Doc({ guid: 'assert-allowed', gc: false });
		const enc = attachEncryption(ydoc);
		attachEncryptedTable(ydoc, enc, 'posts', tableDef);
		attachTable(ydoc, 'cache', tableDef);

		expect(() =>
			enc.assertAllStoresRegistered(ydoc, {
				allowPlaintext: ['table:cache'],
			}),
		).not.toThrow();
	});

	test('ignores non-encryption-capable slots (rich text, timelines, etc.)', () => {
		const ydoc = new Y.Doc({ guid: 'assert-ignore', gc: false });
		const enc = attachEncryption(ydoc);
		attachEncryptedTable(ydoc, enc, 'posts', tableDef);
		// Unrelated Yjs type on a slot that is neither 'kv' nor 'table:*'.
		ydoc.getText('someRichText');

		expect(() => enc.assertAllStoresRegistered(ydoc)).not.toThrow();
	});

	test('error message lists every unregistered slot', () => {
		const ydoc = new Y.Doc({ guid: 'assert-multi', gc: false });
		const enc = attachEncryption(ydoc);
		attachTable(ydoc, 'first', tableDef);
		attachTable(ydoc, 'second', tableDef);

		let caught: Error | undefined;
		try {
			enc.assertAllStoresRegistered(ydoc);
		} catch (err) {
			caught = err as Error;
		}
		expect(caught?.message).toMatch(/table:first/);
		expect(caught?.message).toMatch(/table:second/);
	});
});
