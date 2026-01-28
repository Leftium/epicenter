import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { YKeyValueLww } from '../../core/utils/y-keyvalue-lww.js';
import type { TableDefinition } from '../types.js';
import { createTablesStore } from './tables-store.js';

function createTestStore() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<{
		key: string;
		val: TableDefinition;
		ts: number;
	}>('dynamic:tables');
	const ykv = new YKeyValueLww(yarray);
	const store = createTablesStore(ykv);
	return { ydoc, ykv, store };
}

describe('TablesStore', () => {
	describe('create', () => {
		test('creates a new table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Blog Posts' });

			const table = store.get('posts');
			expect(table).toEqual({
				name: 'Blog Posts',
				deletedAt: null,
				icon: null,
			});
		});

		test('creates a table with icon', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Blog Posts', icon: '📝' });

			const table = store.get('posts');
			expect(table?.icon).toBe('📝');
		});

		test('throws on duplicate tableId', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });

			expect(() => store.create('posts', { name: 'Posts 2' })).toThrow(
				'Table "posts" already exists',
			);
		});

		test('rejects tableId containing colon', () => {
			const { store } = createTestStore();
			expect(() => store.create('my:table', { name: 'Test' })).toThrow(
				'tableId cannot contain',
			);
		});
	});

	describe('get', () => {
		test('returns undefined for non-existent table', () => {
			const { store } = createTestStore();
			expect(store.get('unknown')).toBeUndefined();
		});

		test('returns table definition', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });

			expect(store.get('posts')?.name).toBe('Posts');
		});
	});

	describe('set', () => {
		test('updates an existing table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.set('posts', {
				name: 'Updated Posts',
				deletedAt: null,
				icon: '🔥',
			});

			expect(store.get('posts')).toEqual({
				name: 'Updated Posts',
				deletedAt: null,
				icon: '🔥',
			});
		});

		test('rejects tableId containing colon', () => {
			const { store } = createTestStore();
			expect(() =>
				store.set('my:table', { name: 'Test', deletedAt: null }),
			).toThrow('tableId cannot contain');
		});
	});

	describe('has', () => {
		test('returns false for non-existent table', () => {
			const { store } = createTestStore();
			expect(store.has('unknown')).toBe(false);
		});

		test('returns true for existing table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			expect(store.has('posts')).toBe(true);
		});

		test('returns true for soft-deleted table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.delete('posts');
			expect(store.has('posts')).toBe(true);
		});
	});

	describe('delete (soft)', () => {
		test('soft-deletes a table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.delete('posts');

			const table = store.get('posts');
			expect(table).toBeDefined();
			expect(table?.deletedAt).toBeGreaterThan(0);
		});

		test('no-op for non-existent table', () => {
			const { store } = createTestStore();
			expect(() => store.delete('unknown')).not.toThrow();
		});

		test('no-op for already deleted table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.delete('posts');
			const firstDeletedAt = store.get('posts')?.deletedAt;

			store.delete('posts');
			expect(store.get('posts')?.deletedAt).toBe(firstDeletedAt);
		});
	});

	describe('rename', () => {
		test('renames a table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.rename('posts', 'Blog Posts');

			expect(store.get('posts')?.name).toBe('Blog Posts');
		});

		test('throws for non-existent table', () => {
			const { store } = createTestStore();
			expect(() => store.rename('unknown', 'New Name')).toThrow(
				'Table "unknown" not found',
			);
		});
	});

	describe('restore', () => {
		test('restores a soft-deleted table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.delete('posts');
			expect(store.get('posts')?.deletedAt).not.toBeNull();

			store.restore('posts');
			expect(store.get('posts')?.deletedAt).toBeNull();
		});

		test('no-op for active table', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.restore('posts');
			expect(store.get('posts')?.deletedAt).toBeNull();
		});

		test('throws for non-existent table', () => {
			const { store } = createTestStore();
			expect(() => store.restore('unknown')).toThrow(
				'Table "unknown" not found',
			);
		});
	});

	describe('getAll', () => {
		test('returns all tables including deleted', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.create('users', { name: 'Users' });
			store.delete('posts');

			const all = store.getAll();
			expect(all.size).toBe(2);
			expect(all.has('posts')).toBe(true);
			expect(all.has('users')).toBe(true);
		});
	});

	describe('getActive', () => {
		test('returns only active tables', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });
			store.create('users', { name: 'Users' });
			store.delete('posts');

			const active = store.getActive();
			expect(active.size).toBe(1);
			expect(active.has('posts')).toBe(false);
			expect(active.has('users')).toBe(true);
		});
	});

	describe('observe', () => {
		test('notifies on table creation', () => {
			const { store } = createTestStore();
			const changes: unknown[] = [];
			store.observe((events) => changes.push(...events));

			store.create('posts', { name: 'Posts' });

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				type: 'add',
				key: 'posts',
				value: { name: 'Posts', deletedAt: null, icon: null },
			});
		});

		test('notifies on table update', () => {
			const { store } = createTestStore();
			store.create('posts', { name: 'Posts' });

			const changes: unknown[] = [];
			store.observe((events) => changes.push(...events));

			store.rename('posts', 'Blog Posts');

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				type: 'update',
				key: 'posts',
				previousValue: { name: 'Posts' },
				value: { name: 'Blog Posts' },
			});
		});

		test('unsubscribe stops notifications', () => {
			const { store } = createTestStore();
			const changes: unknown[] = [];
			const unsubscribe = store.observe((events) => changes.push(...events));

			store.create('posts', { name: 'Posts' });
			expect(changes).toHaveLength(1);

			unsubscribe();
			store.create('users', { name: 'Users' });
			expect(changes).toHaveLength(1);
		});
	});
});
