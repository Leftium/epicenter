/**
 * openEncryptedDoc tests: the workspace ydoc factory wires the per-workspace
 * keyring on every registration site (table, kv). Plaintext mode does not
 * exist: registration always activates encryption.
 *
 * Owner-scoped local storage and wipe behavior live in
 * `attach-local-storage.test.ts` and `wipe-local-storage.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import type { SubjectKeyring } from '@epicenter/encryption';
import { bytesToBase64 } from '@epicenter/encryption';
import { randomBytes } from '@noble/ciphers/utils.js';
import { type } from 'arktype';
import { defineTable } from './define-table.js';
import { openEncryptedDoc } from './open-encrypted-doc.js';

function toKeyring(key: Uint8Array): SubjectKeyring {
	return [{ version: 1, subjectKeyBase64: bytesToBase64(key) }];
}

const encryptedRowDefinition = defineTable(
	type({ id: 'string', title: 'string', _v: '1' }),
);

function setup(keyring: SubjectKeyring = toKeyring(randomBytes(32))) {
	const ws = openEncryptedDoc({ id: 'enc-test', keyring: () => keyring });
	const tableA = ws.attachTable('a', encryptedRowDefinition);
	const tableB = ws.attachTable('b', encryptedRowDefinition);
	return { ws, tableA, tableB };
}

describe('openEncryptedDoc', () => {
	test('constructs a gc:true Y.Doc with the supplied id as guid', () => {
		const ws = openEncryptedDoc({
			id: 'epicenter.example',
			keyring: () => toKeyring(randomBytes(32)),
		});
		expect(ws.ydoc.guid).toBe('epicenter.example');
		expect(ws.ydoc.gc).toBe(true);
		ws[Symbol.dispose]();
	});

	test('pins ydoc.clientID when clientId option is set', () => {
		const ws = openEncryptedDoc({
			id: 'enc-pin',
			keyring: () => toKeyring(randomBytes(32)),
			clientId: 42,
		});
		expect(ws.ydoc.clientID).toBe(42);
		ws[Symbol.dispose]();
	});

	test('registered stores accept encrypted writes immediately', () => {
		const { tableA, tableB, ws } = setup();
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
		ws[Symbol.dispose]();
	});

	test('late-registered store activates via keyring callback at registration time', () => {
		const keyring = toKeyring(randomBytes(32));
		const ws = openEncryptedDoc({
			id: 'enc-late-register',
			keyring: () => keyring,
		});

		// Initial table is registered.
		const earlyTable = ws.attachTable('early', encryptedRowDefinition);
		earlyTable.set({ id: '1', title: 'Early', _v: 1 });

		// A later registration also calls keyring() and is encrypted from the start.
		const lateTable = ws.attachTable('late', encryptedRowDefinition);
		lateTable.set({ id: '1', title: 'Written after late register', _v: 1 });
		expect(lateTable.get('1').data).toEqual({
			id: '1',
			title: 'Written after late register',
			_v: 1,
		});
		ws[Symbol.dispose]();
	});

	test('keyring callback throwing at registration surfaces the throw', () => {
		const ws = openEncryptedDoc({
			id: 'enc-no-keys',
			keyring: () => {
				throw new Error('not signed-in');
			},
		});
		expect(() => ws.attachTable('a', encryptedRowDefinition)).toThrow(
			'not signed-in',
		);
		ws[Symbol.dispose]();
	});

	test('attachReadonlyTable reads encrypted rows without exposing writes', () => {
		const keyring = toKeyring(randomBytes(32));
		const ws = openEncryptedDoc({
			id: 'enc-readonly-table',
			keyring: () => keyring,
		});
		const definition = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const writer = ws.attachTable('entries', definition);
		const reader = ws.attachReadonlyTable('entries', definition);

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
		ws[Symbol.dispose]();
	});

	test('attachReadonlyTables returns readonly helpers keyed by definition', () => {
		const keyring = toKeyring(randomBytes(32));
		const ws = openEncryptedDoc({
			id: 'enc-readonly-tables',
			keyring: () => keyring,
		});
		const definition = defineTable(
			type({ id: 'string', title: 'string', _v: '1' }),
		);
		const writers = ws.attachTables({ entries: definition });
		const readers = ws.attachReadonlyTables({ entries: definition });

		writers.entries.set({ id: '1', title: 'Secret row', _v: 1 });

		expect(readers.entries.getAllValid()).toEqual([
			{ id: '1', title: 'Secret row', _v: 1 },
		]);
		expect('set' in readers.entries).toBe(false);
		ws[Symbol.dispose]();
	});

	test('Symbol.dispose destroys the underlying ydoc', () => {
		const ws = openEncryptedDoc({
			id: 'enc-dispose',
			keyring: () => toKeyring(randomBytes(32)),
		});
		expect(ws.ydoc.isDestroyed).toBe(false);
		ws[Symbol.dispose]();
		expect(ws.ydoc.isDestroyed).toBe(true);
	});
});
