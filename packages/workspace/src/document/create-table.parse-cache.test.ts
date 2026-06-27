/**
 * Parsed-Row Cache Tests
 *
 * Verifies the `parseRow` memoization behind `get()` / `scan()` / `findValid()`
 * (see `createReadonlyTable` in `table.ts`). The cache keys on the stored
 * value's object identity, which `YKeyValueLww` keeps stable for unchanged rows.
 * That buys two properties this suite pins down:
 *
 * - Stable row identity: an unchanged row returns the *same* `TRow` object
 *   across reads, even after an unrelated row changes.
 * - Incremental parse: only changed rows are reparsed. An unchanged row keeping
 *   its object reference is the observable proof it was served from the cache
 *   rather than parsed again.
 *
 * Identity is the whole point: it lets the Svelte `fromTable` adapter stay a
 * stateless view (re-`scan()` on every change) without churning keyed renders.
 */

import { describe, expect, test } from 'bun:test';
import { field } from '@epicenter/field';
import * as Y from 'yjs';
import { defineTable } from './define-table.js';
import { createTable } from './table.js';
import { YKeyValueLww, type YKeyValueLwwEntry } from './y-keyvalue/index.js';

function setup() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>('test-table');
	const ykv = new YKeyValueLww<unknown>(yarray);
	const definition = defineTable({
		id: field.string(),
		title: field.string(),
	});
	const table = createTable(ykv, definition, 'test');
	return { ydoc, ykv, table };
}

const byId = <T extends { id: string }>(rows: T[]) =>
	new Map(rows.map((r) => [r.id, r]));

describe('parsed-row cache', () => {
	test('a repeated scan returns the same row object for every unchanged row', () => {
		const { table } = setup();
		table.set({ id: '1', title: 'a' });
		table.set({ id: '2', title: 'b' });

		const first = byId(table.scan().rows);
		const second = byId(table.scan().rows);

		expect(second.get('1')).toBe(first.get('1'));
		expect(second.get('2')).toBe(first.get('2'));
	});

	test('changing one row reparses only that row; the rest keep their identity', () => {
		const { table } = setup();
		table.set({ id: '1', title: 'a' });
		table.set({ id: '2', title: 'b' });
		table.set({ id: '3', title: 'c' });

		const before = byId(table.scan().rows);
		table.set({ id: '2', title: 'B' });
		const after = byId(table.scan().rows);

		// Unchanged rows are served from the cache: same object reference.
		expect(after.get('1')).toBe(before.get('1'));
		expect(after.get('3')).toBe(before.get('3'));
		// The changed row is reparsed: new object, new value.
		expect(after.get('2')).not.toBe(before.get('2'));
		expect(after.get('2')).toEqual({ id: '2', title: 'B' });
	});

	test('get() and scan() share the cache: same object from both reads', () => {
		const { table } = setup();
		table.set({ id: '1', title: 'a' });

		const fromScan = byId(table.scan().rows).get('1');
		const fromGet = table.get('1').data ?? undefined;

		expect(fromGet).toBe(fromScan);
	});

	test('a deleted then re-created row is a fresh object, not a stale cache hit', () => {
		const { table } = setup();
		table.set({ id: '1', title: 'a' });
		const original = table.get('1').data;

		table.delete('1');
		expect(table.get('1').data).toBeNull();

		table.set({ id: '1', title: 'a' });
		const recreated = table.get('1').data;

		expect(recreated).not.toBe(original);
		expect(recreated).toEqual({ id: '1', title: 'a' });
	});
});
