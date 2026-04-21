/**
 * attachTables reentrance tests.
 *
 * `attachTables` (plural) must share the `attachTable` slot namespace so that
 * the invariant "a table named X is attached to this Y.Doc at most once" holds
 * regardless of which function did the attaching. Otherwise `attachTables`
 * would bypass the per-table guard and silently hand out a second wrapper over
 * the same Y.Array slot — the exact data-loss bug the guard was meant to
 * prevent.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachTable } from '@epicenter/document';
import { attachTables } from './attach-tables.js';
import { defineTable } from './define-table.js';

function makeDefs() {
	return {
		entries: defineTable(type({ id: 'string', name: 'string', _v: '1' })),
	};
}

describe('attachTables — reentrance guard', () => {
	test('attachTables called twice with the same table name throws', () => {
		const ydoc = new Y.Doc({ guid: 'attach-tables-reentrance' });
		attachTables(ydoc, makeDefs());

		expect(() => attachTables(ydoc, makeDefs())).toThrow(/entries/);
	});

	test('attachTables then attachTable on the same slot throws', () => {
		const ydoc = new Y.Doc({ guid: 'attach-tables-then-attach-table' });
		attachTables(ydoc, makeDefs());

		const def = defineTable(type({ id: 'string', name: 'string', _v: '1' }));
		expect(() => attachTable(ydoc, 'entries', def)).toThrow(/entries/);
	});

	test('attachTable then attachTables on the same slot throws', () => {
		const ydoc = new Y.Doc({ guid: 'attach-table-then-attach-tables' });
		const def = defineTable(type({ id: 'string', name: 'string', _v: '1' }));
		attachTable(ydoc, 'entries', def);

		expect(() => attachTables(ydoc, makeDefs())).toThrow(/entries/);
	});

	test('destroy then reattach on the same Y.Doc does not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-tables-destroy-reattach' });
		attachTables(ydoc, makeDefs());
		ydoc.destroy();

		expect(() => attachTables(ydoc, makeDefs())).not.toThrow();
	});

	test('separate Y.Docs do not interfere', () => {
		const docA = new Y.Doc({ guid: 'attach-tables-doc-a' });
		const docB = new Y.Doc({ guid: 'attach-tables-doc-b' });
		attachTables(docA, makeDefs());

		expect(() => attachTables(docB, makeDefs())).not.toThrow();
	});
});
