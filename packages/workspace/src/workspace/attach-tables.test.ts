/**
 * attachEncryptedTables reentrance tests.
 *
 * The encrypted batch and singular forms share the same `AttachPrimitive.Table`
 * slot as the plaintext `attachTable` from `@epicenter/document`. The invariant
 * is "a table named X is attached to this Y.Doc at most once" regardless of
 * which function did the attaching — otherwise the batch form would bypass the
 * per-table guard and silently hand out a second wrapper over the same Y.Array
 * slot.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachTable } from '@epicenter/document';
import { attachEncryption } from '../shared/attach-encryption.js';
import {
	attachEncryptedTable,
	attachEncryptedTables,
} from './attach-tables.js';
import { defineTable } from './define-table.js';

function makeDefs() {
	return {
		entries: defineTable(type({ id: 'string', name: 'string', _v: '1' })),
	};
}

describe('attachEncryptedTables — reentrance guard', () => {
	test('attachEncryptedTables called twice with the same table name throws', () => {
		const ydoc = new Y.Doc({ guid: 'attach-tables-reentrance' });
		const enc = attachEncryption(ydoc);
		attachEncryptedTables(ydoc, enc, makeDefs());

		expect(() => attachEncryptedTables(ydoc, enc, makeDefs())).toThrow(
			/entries/,
		);
	});

	test('attachEncryptedTables then plaintext attachTable on the same slot throws', () => {
		const ydoc = new Y.Doc({ guid: 'attach-tables-then-attach-table' });
		const enc = attachEncryption(ydoc);
		attachEncryptedTables(ydoc, enc, makeDefs());

		const def = defineTable(type({ id: 'string', name: 'string', _v: '1' }));
		expect(() => attachTable(ydoc, 'entries', def)).toThrow(/entries/);
	});

	test('plaintext attachTable then attachEncryptedTables on the same slot throws', () => {
		const ydoc = new Y.Doc({ guid: 'attach-table-then-attach-tables' });
		const def = defineTable(type({ id: 'string', name: 'string', _v: '1' }));
		attachTable(ydoc, 'entries', def);
		const enc = attachEncryption(ydoc);

		expect(() => attachEncryptedTables(ydoc, enc, makeDefs())).toThrow(
			/entries/,
		);
	});

	test('attachEncryptedTable and attachEncryptedTables share the same slot', () => {
		const ydoc = new Y.Doc({ guid: 'attach-encrypted-mix' });
		const enc = attachEncryption(ydoc);
		const def = defineTable(type({ id: 'string', name: 'string', _v: '1' }));
		attachEncryptedTable(ydoc, enc, 'entries', def);

		expect(() => attachEncryptedTables(ydoc, enc, makeDefs())).toThrow(
			/entries/,
		);
	});

	test('destroy then reattach on the same Y.Doc does not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-tables-destroy-reattach' });
		const enc = attachEncryption(ydoc);
		attachEncryptedTables(ydoc, enc, makeDefs());
		ydoc.destroy();

		const ydoc2 = new Y.Doc({ guid: 'attach-tables-destroy-reattach-2' });
		const enc2 = attachEncryption(ydoc2);
		expect(() => attachEncryptedTables(ydoc2, enc2, makeDefs())).not.toThrow();
	});

	test('separate Y.Docs do not interfere', () => {
		const docA = new Y.Doc({ guid: 'attach-tables-doc-a' });
		const docB = new Y.Doc({ guid: 'attach-tables-doc-b' });
		const encA = attachEncryption(docA);
		const encB = attachEncryption(docB);
		attachEncryptedTables(docA, encA, makeDefs());

		expect(() => attachEncryptedTables(docB, encB, makeDefs())).not.toThrow();
	});
});
