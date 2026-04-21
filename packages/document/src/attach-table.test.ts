/**
 * attachTable reentrance tests (TDD — failing before Phase 3 guards land).
 *
 * Today `attachTable` silently hands out a fresh wrapper over the same Y.Array
 * slot on each call, which can cause subtle data-loss bugs when two callers
 * each think they own the store. Phase 3 of the defineDocument collapse spec
 * adds a reentrance guard that throws on the second attach to the same
 * (ydoc, name) slot.
 *
 * These tests pin that future invariant. The "second attach throws" and the
 * silent-data-loss-is-loud-now test are expected to FAIL today.
 */

import { describe, expect, test } from 'bun:test';
import { type } from 'arktype';
import * as Y from 'yjs';
import { attachTable } from './attach-table.js';
import type { TableDefinition } from './types.js';

/** Minimal TableDefinition fixture — arktype schema + identity migrate. */
function makeTableDef() {
	const schema = type({ id: 'string', name: 'string', _v: '1' });
	return {
		schema,
		migrate: (row: unknown) => row as { id: string; name: string; _v: 1 },
	} as unknown as TableDefinition<any>;
}

describe('attachTable — reentrance guard', () => {
	test('destroy then reattach on the same Y.Doc does not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-table-destroy-reattach' });
		const def = makeTableDef();
		attachTable(ydoc, 'entries', def);
		ydoc.destroy();

		expect(() => attachTable(ydoc, 'entries', def)).not.toThrow();
	});

	test('separate Y.Docs do not interfere', () => {
		const docA = new Y.Doc({ guid: 'attach-table-doc-a' });
		const docB = new Y.Doc({ guid: 'attach-table-doc-b' });
		const def = makeTableDef();
		attachTable(docA, 'entries', def);

		expect(() => attachTable(docB, 'entries', def)).not.toThrow();
	});

	test('different names on the same Y.Doc do not throw', () => {
		const ydoc = new Y.Doc({ guid: 'attach-table-different-names' });
		const def = makeTableDef();
		attachTable(ydoc, 'entries', def);

		expect(() => attachTable(ydoc, 'other', def)).not.toThrow();
	});

});
