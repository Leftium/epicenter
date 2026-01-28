import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { YKeyValueLww } from '../../core/utils/y-keyvalue-lww.js';
import type { RowMeta } from '../types.js';
import { createRowsStore } from './rows-store.js';

function createTestStore() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<{ key: string; val: RowMeta; ts: number }>(
		'dynamic:rows',
	);
	const ykv = new YKeyValueLww(yarray);
	const store = createRowsStore(ykv);
	return { ydoc, ykv, store };
}

describe('RowsStore', () => {
	describe('create', () => {
		test('creates a new row with auto-generated ID', () => {
			const { store } = createTestStore();
			const rowId = store.create('posts');

			expect(rowId).toHaveLength(12);
			expect(rowId).toMatch(/^[a-z0-9]+$/);

			const row = store.get('posts', rowId);
			expect(row).toEqual({
				order: 1,
				deletedAt: null,
			});
		});

		test('creates a row with explicit ID', () => {
			const { store } = createTestStore();
			const rowId = store.create('posts', 'custom-id');

			expect(rowId).toBe('custom-id');
			expect(store.has('posts', 'custom-id')).toBe(true);
		});

		test('creates a row with explicit order', () => {
			const { store } = createTestStore();
			const rowId = store.create('posts', undefined, 5);

			expect(store.get('posts', rowId)?.order).toBe(5);
		});

		test('auto-increments order for subsequent rows', () => {
			const { store } = createTestStore();
			const row1 = store.create('posts');
			const row2 = store.create('posts');
			const row3 = store.create('posts');

			expect(store.get('posts', row1)?.order).toBe(1);
			expect(store.get('posts', row2)?.order).toBe(2);
			expect(store.get('posts', row3)?.order).toBe(3);
		});

		test('throws on duplicate rowId', () => {
			const { store } = createTestStore();
			store.create('posts', 'row1');

			expect(() => store.create('posts', 'row1')).toThrow(
				'Row "row1" already exists in table "posts"',
			);
		});

		test('allows same rowId in different tables', () => {
			const { store } = createTestStore();
			store.create('posts', 'row1');
			store.create('pages', 'row1');

			expect(store.has('posts', 'row1')).toBe(true);
			expect(store.has('pages', 'row1')).toBe(true);
		});

		test('rejects IDs containing colon', () => {
			const { store } = createTestStore();
			expect(() => store.create('my:table')).toThrow('tableId cannot contain');
			expect(() => store.create('posts', 'my:row')).toThrow(
				'rowId cannot contain',
			);
		});
	});

	describe('get/has', () => {
		test('returns undefined for non-existent row', () => {
			const { store } = createTestStore();
			expect(store.get('posts', 'unknown')).toBeUndefined();
		});

		test('has returns false for non-existent row', () => {
			const { store } = createTestStore();
			expect(store.has('posts', 'unknown')).toBe(false);
		});

		test('has returns true for existing row', () => {
			const { store } = createTestStore();
			const rowId = store.create('posts');
			expect(store.has('posts', rowId)).toBe(true);
		});
	});

	describe('set', () => {
		test('updates an existing row', () => {
			const { store } = createTestStore();
			const rowId = store.create('posts');
			store.set('posts', rowId, { order: 10, deletedAt: null });

			expect(store.get('posts', rowId)?.order).toBe(10);
		});
	});

	describe('delete (soft)', () => {
		test('soft-deletes a row', () => {
			const { store } = createTestStore();
			const rowId = store.create('posts');
			store.delete('posts', rowId);

			const row = store.get('posts', rowId);
			expect(row).toBeDefined();
			expect(row?.deletedAt).toBeGreaterThan(0);
		});

		test('no-op for non-existent row', () => {
			const { store } = createTestStore();
			expect(() => store.delete('posts', 'unknown')).not.toThrow();
		});

		test('excludes deleted rows from order calculation', () => {
			const { store } = createTestStore();
			const row1 = store.create('posts'); // order: 1
			const row2 = store.create('posts'); // order: 2
			store.delete('posts', row2);
			const row3 = store.create('posts'); // order: 2 (not 3)

			expect(store.get('posts', row1)?.order).toBe(1);
			expect(store.get('posts', row3)?.order).toBe(2);
		});
	});

	describe('reorder', () => {
		test('reorders a row', () => {
			const { store } = createTestStore();
			const row1 = store.create('posts');
			const row2 = store.create('posts');
			const row3 = store.create('posts');

			// Move row3 between row1 and row2
			store.reorder('posts', row3, 1.5);

			const rows = store.getActiveByTable('posts');
			expect(rows.map((r) => r.id)).toEqual([row1, row3, row2]);
		});

		test('throws for non-existent row', () => {
			const { store } = createTestStore();
			expect(() => store.reorder('posts', 'unknown', 1)).toThrow(
				'Row "unknown" not found in table "posts"',
			);
		});
	});

	describe('restore', () => {
		test('restores a soft-deleted row', () => {
			const { store } = createTestStore();
			const rowId = store.create('posts');
			store.delete('posts', rowId);
			expect(store.get('posts', rowId)?.deletedAt).not.toBeNull();

			store.restore('posts', rowId);
			expect(store.get('posts', rowId)?.deletedAt).toBeNull();
		});

		test('no-op for active row', () => {
			const { store } = createTestStore();
			const rowId = store.create('posts');
			store.restore('posts', rowId);
			expect(store.get('posts', rowId)?.deletedAt).toBeNull();
		});

		test('throws for non-existent row', () => {
			const { store } = createTestStore();
			expect(() => store.restore('posts', 'unknown')).toThrow(
				'Row "unknown" not found in table "posts"',
			);
		});
	});

	describe('getByTable', () => {
		test('returns rows sorted by order', () => {
			const { store } = createTestStore();
			store.create('posts', 'row3', 3);
			store.create('posts', 'row1', 1);
			store.create('posts', 'row2', 2);

			const rows = store.getByTable('posts');
			expect(rows.map((r) => r.id)).toEqual(['row1', 'row2', 'row3']);
		});

		test('includes soft-deleted rows', () => {
			const { store } = createTestStore();
			const row1 = store.create('posts');
			store.create('posts');
			store.delete('posts', row1);

			const rows = store.getByTable('posts');
			expect(rows).toHaveLength(2);
		});

		test('uses rowId as tiebreaker for equal orders', () => {
			const { store } = createTestStore();
			store.create('posts', 'beta', 1);
			store.create('posts', 'alpha', 1);

			const rows = store.getByTable('posts');
			expect(rows.map((r) => r.id)).toEqual(['alpha', 'beta']);
		});

		test('returns empty array for non-existent table', () => {
			const { store } = createTestStore();
			expect(store.getByTable('unknown')).toEqual([]);
		});

		test('returns only rows for specified table', () => {
			const { store } = createTestStore();
			store.create('posts', 'post-row');
			store.create('pages', 'page-row');

			const postRows = store.getByTable('posts');
			expect(postRows).toHaveLength(1);
			expect(postRows[0]!.id).toBe('post-row');
		});
	});

	describe('getActiveByTable', () => {
		test('excludes soft-deleted rows', () => {
			const { store } = createTestStore();
			const row1 = store.create('posts');
			const row2 = store.create('posts');
			store.delete('posts', row1);

			const rows = store.getActiveByTable('posts');
			expect(rows).toHaveLength(1);
			expect(rows[0]!.id).toBe(row2);
		});
	});

	describe('observe', () => {
		test('notifies on row creation', () => {
			const { store } = createTestStore();
			const changes: unknown[] = [];
			store.observe((events) => changes.push(...events));

			const rowId = store.create('posts');

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				type: 'add',
				key: `posts:${rowId}`,
				value: { order: 1, deletedAt: null },
			});
		});

		test('unsubscribe stops notifications', () => {
			const { store } = createTestStore();
			const changes: unknown[] = [];
			const unsubscribe = store.observe((events) => changes.push(...events));

			store.create('posts');
			expect(changes).toHaveLength(1);

			unsubscribe();
			store.create('posts');
			expect(changes).toHaveLength(1);
		});
	});
});
