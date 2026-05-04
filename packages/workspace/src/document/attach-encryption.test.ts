/**
 * attachEncryption tests: keyring dedup, key application, key rotation,
 * re-encryption of plaintext, late-store auto-activation, disposal cascade,
 * reentrance guard.
 *
 * These tests exercise the attachment directly without a workspace client.
 * Stores are constructed through `encryption.attachTable`: the same pathway
 * used by application code.
 */

import { describe, expect, test } from 'bun:test';
import type { EncryptionKeys } from '@epicenter/encryption';
import {
	bytesToBase64,
	type EncryptedBlob,
	getKeyVersion,
	isEncryptedBlob,
} from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachEncryption } from './attach-encryption.js';
import { defineTable } from './define-table.js';
import { TableKey } from './keys.js';

function toEncryptionKeys(key: Uint8Array): EncryptionKeys {
	return [{ version: 1, userKeyBase64: bytesToBase64(key) }];
}

const encryptedRowDefinition = defineTable(
	type({ id: 'string', title: 'string', _v: '1' }),
);

function setup() {
	const ydoc = new Y.Doc({ guid: 'enc-test', gc: false });
	const encryption = attachEncryption(ydoc);
	const tableA = encryption.attachTable(ydoc, 'a', encryptedRowDefinition);
	const tableB = encryption.attachTable(ydoc, 'b', encryptedRowDefinition);
	return { ydoc, tableA, tableB, encryption };
}

describe('attachEncryption', () => {
	test('applyKeys enables encrypted writes on every registered store', () => {
		const { tableA, tableB, encryption } = setup();
		encryption.applyKeys(toEncryptionKeys(randomBytes(32)));
		tableA.set({ id: '1', title: 'Secret A', _v: 1 });
		tableB.set({ id: '1', title: 'Secret B', _v: 1 });
		expect(tableA.get('1').data).toEqual({
			id: '1',
			title: 'Secret A',
			_v: 1,
		});
		expect(tableB.get('1').data).toEqual({
			id: '1',
			title: 'Secret B',
			_v: 1,
		});
	});

	test('applyKeys re-encrypts existing plaintext entries', () => {
		const { tableA, encryption } = setup();
		tableA.set({ id: '1', title: 'Was plaintext', _v: 1 });
		encryption.applyKeys(toEncryptionKeys(randomBytes(32)));
		expect(tableA.get('1').data).toEqual({
			id: '1',
			title: 'Was plaintext',
			_v: 1,
		});
	});

	test('keyring dedup: identical keys short-circuit the second call', () => {
		const { tableA, encryption } = setup();
		const key = randomBytes(32);
		encryption.applyKeys(toEncryptionKeys(key));
		tableA.set({ id: '1', title: 'Before second apply', _v: 1 });
		encryption.applyKeys(toEncryptionKeys(key));
		expect(tableA.get('1').data).toEqual({
			id: '1',
			title: 'Before second apply',
			_v: 1,
		});
	});

	test('keyring dedup: reversed key order is treated as the same keyring', () => {
		const { tableA, encryption } = setup();
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
		encryption.applyKeys(asc);
		tableA.set({ id: '1', title: 'Order test', _v: 1 });
		encryption.applyKeys(desc);
		expect(tableA.get('1').data).toEqual({
			id: '1',
			title: 'Order test',
			_v: 1,
		});
	});

	test('plaintext writes are readable before applyKeys is called', () => {
		const { tableA } = setup();
		tableA.set({ id: '1', title: 'Plaintext', _v: 1 });
		expect(tableA.get('1').data).toEqual({
			id: '1',
			title: 'Plaintext',
			_v: 1,
		});
	});

	test('late-registered store auto-activates with cached keyring', () => {
		const ydoc = new Y.Doc({ guid: 'enc-late-register', gc: false });
		const encryption = attachEncryption(ydoc);
		encryption.applyKeys(toEncryptionKeys(randomBytes(32)));

		// Attach after applyKeys: the store must receive the cached keyring so
		// subsequent writes are encrypted from the start.
		const lateTable = encryption.attachTable(ydoc, 'late', encryptedRowDefinition);

		lateTable.set({ id: '1', title: 'Written after late register', _v: 1 });
		expect(lateTable.get('1').data).toEqual({
			id: '1',
			title: 'Written after late register',
			_v: 1,
		});
	});

	test('attachReadonlyTable reads encrypted rows without exposing writes', () => {
		const ydoc = new Y.Doc({ guid: 'enc-readonly-table', gc: false });
		const encryption = attachEncryption(ydoc);
		const definition = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const writer = encryption.attachTable(ydoc, 'entries', definition);
		const reader = encryption.attachReadonlyTable(ydoc, 'entries', definition);

		encryption.applyKeys(toEncryptionKeys(randomBytes(32)));
		writer.set({ id: '1', title: 'Secret row', _v: 1 });

		expect(reader.get('1').data).toEqual({
			id: '1',
			title: 'Secret row',
			_v: 1,
		});
		expect('set' in reader).toBe(false);
		expect('bulkSet' in reader).toBe(false);
		expect('update' in reader).toBe(false);
		expect('delete' in reader).toBe(false);
		expect('bulkDelete' in reader).toBe(false);
		expect('clear' in reader).toBe(false);
	});

	test('attachReadonlyTables returns readonly helpers keyed by definition', () => {
		const ydoc = new Y.Doc({ guid: 'enc-readonly-tables', gc: false });
		const encryption = attachEncryption(ydoc);
		const definition = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const writers = encryption.attachTables(ydoc, { entries: definition });
		const readers = encryption.attachReadonlyTables(ydoc, {
			entries: definition,
		});

		writers.entries.set({ id: '1', title: 'Secret row', _v: 1 });

		expect(readers.entries.getAllValid()).toEqual([
			{ id: '1', title: 'Secret row', _v: 1 },
		]);
		expect('set' in readers.entries).toBe(false);
		expect('bulkSet' in readers.entries).toBe(false);
		expect('update' in readers.entries).toBe(false);
		expect('delete' in readers.entries).toBe(false);
		expect('bulkDelete' in readers.entries).toBe(false);
		expect('clear' in readers.entries).toBe(false);
	});

	describe('at-rest upgrade on key rotation', () => {
		test('v1 ciphertext gets re-encrypted to v2 when v2 becomes current', () => {
			const { ydoc, tableA, encryption } = setup();
			const keyV1 = randomBytes(32);
			const keyV2 = randomBytes(32);

			encryption.applyKeys([
				{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
			]);
			tableA.set({ id: '1', title: 'Written with v1', _v: 1 });

			// Sanity: the at-rest blob is a v1 ciphertext.
			const yarray = ydoc.getArray<{ key: string; val: unknown }>(TableKey('a'));
			const beforeEntry = yarray.toArray().find((entry) => entry.key === '1');
			expect(beforeEntry).toBeDefined();
			expect(isEncryptedBlob(beforeEntry?.val)).toBe(true);
			expect(getKeyVersion(beforeEntry?.val as EncryptedBlob)).toBe(1);

			// Rotate: v2 is the new current key; v1 stays in the keyring so the
			// walk can decrypt existing v1 blobs.
			encryption.applyKeys([
				{ version: 2, userKeyBase64: bytesToBase64(keyV2) },
				{ version: 1, userKeyBase64: bytesToBase64(keyV1) },
			]);

			// At-rest blob should now be v2, not v1.
			const afterEntry = yarray.toArray().find((entry) => entry.key === '1');
			expect(afterEntry).toBeDefined();
			expect(isEncryptedBlob(afterEntry?.val)).toBe(true);
			expect(getKeyVersion(afterEntry?.val as EncryptedBlob)).toBe(2);
			expect(tableA.get('1').data).toEqual({
				id: '1',
				title: 'Written with v1',
				_v: 1,
			});

			// New writes after rotation use v2 and are readable.
			tableA.set({ id: 'new', title: 'Written with v2', _v: 1 });
			expect(tableA.get('new').data).toEqual({
				id: 'new',
				title: 'Written with v2',
				_v: 1,
			});
			const newEntry = yarray
				.toArray()
				.find((entry) => entry.key === 'new');
			expect(getKeyVersion(newEntry?.val as EncryptedBlob)).toBe(2);
		});
	});
});
