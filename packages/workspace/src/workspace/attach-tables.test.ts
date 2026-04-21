/**
 * attachEncryptedTables tests.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachEncryption } from '../shared/attach-encryption.js';
import { attachEncryptedTables } from './attach-tables.js';
import { defineTable } from './define-table.js';

function makeDefs() {
	return {
		entries: defineTable(type({ id: 'string', name: 'string', _v: '1' })),
	};
}

describe('attachEncryptedTables — reentrance guard', () => {
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
