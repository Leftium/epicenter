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
	test('second attach to same (ydoc, name) throws with a clear message naming the slot', () => {
		const ydoc = new Y.Doc({ guid: 'attach-table-reentrance' });
		const def = makeTableDef();
		attachTable(ydoc, 'entries', def);

		expect(() => attachTable(ydoc, 'entries', def)).toThrow(/entries/);
	});

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

	test('silent-data-loss scenario is loud: second attach throws BEFORE any mutation on the second wrapper', () => {
		const ydoc = new Y.Doc({ guid: 'attach-table-loud' });
		const def = makeTableDef();
		const first = attachTable(ydoc, 'entries', def);
		first.set({ id: '1', name: 'alpha', _v: 1 } as any);

		let secondWrapperReached = false;
		expect(() => {
			const second = attachTable(ydoc, 'entries', def);
			secondWrapperReached = true;
			// Would have been a latent conflicting write, but the guard should
			// prevent us from ever holding `second`.
			second.set({ id: '2', name: 'beta', _v: 1 } as any);
		}).toThrow(/entries/);

		expect(secondWrapperReached).toBe(false);
		// First wrapper's write survives — no silent mutation through a phantom
		// second wrapper clobbered anything.
		const row = first.get('1');
		expect(row.status).toBe('valid');
	});
});
