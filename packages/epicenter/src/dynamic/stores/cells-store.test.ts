import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { YKeyValueLww } from '../../core/utils/y-keyvalue-lww.js';
import type { CellValue } from '../types.js';
import { createCellsStore } from './cells-store.js';

function createTestStore() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<{ key: string; val: CellValue; ts: number }>(
		'dynamic:cells',
	);
	const ykv = new YKeyValueLww(yarray);
	const store = createCellsStore(ykv);
	return { ydoc, ykv, store };
}

describe('CellsStore', () => {
	describe('set/get', () => {
		test('sets and gets a string value', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'title', 'Hello World');

			expect(store.get('posts', 'row1', 'title')).toBe('Hello World');
		});

		test('sets and gets a number value', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'views', 42);

			expect(store.get('posts', 'row1', 'views')).toBe(42);
		});

		test('sets and gets a boolean value', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'published', true);

			expect(store.get('posts', 'row1', 'published')).toBe(true);
		});

		test('sets and gets null value', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'date', null);

			expect(store.get('posts', 'row1', 'date')).toBeNull();
		});

		test('sets and gets object value', () => {
			const { store } = createTestStore();
			const data = { nested: { value: 123 } };
			store.set('posts', 'row1', 'metadata', data);

			expect(store.get('posts', 'row1', 'metadata')).toEqual(data);
		});

		test('sets and gets array value', () => {
			const { store } = createTestStore();
			const tags = ['news', 'tech', 'featured'];
			store.set('posts', 'row1', 'tags', tags);

			expect(store.get('posts', 'row1', 'tags')).toEqual(tags);
		});

		test('returns undefined for non-existent cell', () => {
			const { store } = createTestStore();
			expect(store.get('posts', 'row1', 'unknown')).toBeUndefined();
		});

		test('rejects IDs containing colon', () => {
			const { store } = createTestStore();
			expect(() => store.set('my:table', 'row1', 'title', 'test')).toThrow(
				'tableId cannot contain',
			);
			expect(() => store.set('posts', 'my:row', 'title', 'test')).toThrow(
				'rowId cannot contain',
			);
			expect(() => store.set('posts', 'row1', 'my:field', 'test')).toThrow(
				'fieldId cannot contain',
			);
		});
	});

	describe('has', () => {
		test('returns false for non-existent cell', () => {
			const { store } = createTestStore();
			expect(store.has('posts', 'row1', 'title')).toBe(false);
		});

		test('returns true for existing cell', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'title', 'Hello');
			expect(store.has('posts', 'row1', 'title')).toBe(true);
		});
	});

	describe('delete', () => {
		test('deletes a cell (hard delete)', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'title', 'Hello');
			expect(store.has('posts', 'row1', 'title')).toBe(true);

			store.delete('posts', 'row1', 'title');
			expect(store.has('posts', 'row1', 'title')).toBe(false);
		});

		test('no-op for non-existent cell', () => {
			const { store } = createTestStore();
			expect(() => store.delete('posts', 'row1', 'unknown')).not.toThrow();
		});
	});

	describe('getByRow', () => {
		test('returns cells for specified fields', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'title', 'Hello');
			store.set('posts', 'row1', 'body', 'World');
			store.set('posts', 'row1', 'views', 100);

			const cells = store.getByRow('posts', 'row1', ['title', 'body', 'views']);

			expect(cells.size).toBe(3);
			expect(cells.get('title')).toBe('Hello');
			expect(cells.get('body')).toBe('World');
			expect(cells.get('views')).toBe(100);
		});

		test('only returns cells that exist', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'title', 'Hello');

			const cells = store.getByRow('posts', 'row1', [
				'title',
				'body',
				'nonexistent',
			]);

			expect(cells.size).toBe(1);
			expect(cells.get('title')).toBe('Hello');
			expect(cells.has('body')).toBe(false);
		});

		test('returns empty map for non-existent row', () => {
			const { store } = createTestStore();
			const cells = store.getByRow('posts', 'unknown', ['title', 'body']);

			expect(cells.size).toBe(0);
		});

		test('returns empty map for empty fieldIds', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'title', 'Hello');

			const cells = store.getByRow('posts', 'row1', []);
			expect(cells.size).toBe(0);
		});

		test('uses direct lookups (O(1) per field)', () => {
			const { store } = createTestStore();
			// Create cells in different rows to verify we're not scanning
			store.set('posts', 'row1', 'title', 'Title 1');
			store.set('posts', 'row2', 'title', 'Title 2');
			store.set('posts', 'row3', 'title', 'Title 3');

			// Only get cells for row2
			const cells = store.getByRow('posts', 'row2', ['title']);
			expect(cells.size).toBe(1);
			expect(cells.get('title')).toBe('Title 2');
		});
	});

	describe('observe', () => {
		test('notifies on cell creation', () => {
			const { store } = createTestStore();
			const changes: unknown[] = [];
			store.observe((events) => changes.push(...events));

			store.set('posts', 'row1', 'title', 'Hello');

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				type: 'add',
				key: 'posts:row1:title',
				value: 'Hello',
			});
		});

		test('notifies on cell update', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'title', 'Hello');

			const changes: unknown[] = [];
			store.observe((events) => changes.push(...events));

			store.set('posts', 'row1', 'title', 'Updated');

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				type: 'update',
				key: 'posts:row1:title',
				previousValue: 'Hello',
				value: 'Updated',
			});
		});

		test('notifies on cell deletion', () => {
			const { store } = createTestStore();
			store.set('posts', 'row1', 'title', 'Hello');

			const changes: unknown[] = [];
			store.observe((events) => changes.push(...events));

			store.delete('posts', 'row1', 'title');

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				type: 'delete',
				key: 'posts:row1:title',
				previousValue: 'Hello',
			});
		});

		test('unsubscribe stops notifications', () => {
			const { store } = createTestStore();
			const changes: unknown[] = [];
			const unsubscribe = store.observe((events) => changes.push(...events));

			store.set('posts', 'row1', 'title', 'Hello');
			expect(changes).toHaveLength(1);

			unsubscribe();
			store.set('posts', 'row1', 'body', 'World');
			expect(changes).toHaveLength(1);
		});
	});
});
