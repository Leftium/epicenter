import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { YKeyValueLww } from '../../core/utils/y-keyvalue-lww.js';
import type { FieldDefinition } from '../types.js';
import { createFieldsStore } from './fields-store.js';

function createTestStore() {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<{
		key: string;
		val: FieldDefinition;
		ts: number;
	}>('dynamic:fields');
	const ykv = new YKeyValueLww(yarray);
	const store = createFieldsStore(ykv);
	return { ydoc, ykv, store };
}

describe('FieldsStore', () => {
	describe('create', () => {
		test('creates a new field with auto-order', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });

			const field = store.get('posts', 'title');
			expect(field).toEqual({
				name: 'Title',
				type: 'text',
				order: 1,
				deletedAt: null,
				icon: null,
			});
		});

		test('creates field with explicit order', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text', order: 5 });

			expect(store.get('posts', 'title')?.order).toBe(5);
		});

		test('auto-increments order for subsequent fields', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.create('posts', 'body', { name: 'Body', type: 'text' });
			store.create('posts', 'published', {
				name: 'Published',
				type: 'boolean',
			});

			expect(store.get('posts', 'title')?.order).toBe(1);
			expect(store.get('posts', 'body')?.order).toBe(2);
			expect(store.get('posts', 'published')?.order).toBe(3);
		});

		test('creates field with options', () => {
			const { store } = createTestStore();
			store.create('posts', 'status', {
				name: 'Status',
				type: 'select',
				options: ['draft', 'published', 'archived'],
			});

			const field = store.get('posts', 'status');
			expect(field?.options).toEqual(['draft', 'published', 'archived']);
		});

		test('creates field with default value', () => {
			const { store } = createTestStore();
			store.create('posts', 'views', {
				name: 'Views',
				type: 'integer',
				default: 0,
			});

			expect(store.get('posts', 'views')?.default).toBe(0);
		});

		test('throws on duplicate fieldId', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });

			expect(() =>
				store.create('posts', 'title', { name: 'Title 2', type: 'text' }),
			).toThrow('Field "title" already exists in table "posts"');
		});

		test('allows same fieldId in different tables', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Post Title', type: 'text' });
			store.create('pages', 'title', { name: 'Page Title', type: 'text' });

			expect(store.get('posts', 'title')?.name).toBe('Post Title');
			expect(store.get('pages', 'title')?.name).toBe('Page Title');
		});

		test('rejects IDs containing colon', () => {
			const { store } = createTestStore();
			expect(() =>
				store.create('my:table', 'title', { name: 'Title', type: 'text' }),
			).toThrow('tableId cannot contain');
			expect(() =>
				store.create('posts', 'my:field', { name: 'Title', type: 'text' }),
			).toThrow('fieldId cannot contain');
		});
	});

	describe('get/has', () => {
		test('returns undefined for non-existent field', () => {
			const { store } = createTestStore();
			expect(store.get('posts', 'unknown')).toBeUndefined();
		});

		test('has returns false for non-existent field', () => {
			const { store } = createTestStore();
			expect(store.has('posts', 'unknown')).toBe(false);
		});

		test('has returns true for existing field', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			expect(store.has('posts', 'title')).toBe(true);
		});
	});

	describe('set', () => {
		test('updates an existing field', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.set('posts', 'title', {
				name: 'Updated Title',
				type: 'text',
				order: 1,
				deletedAt: null,
				icon: '📝',
			});

			expect(store.get('posts', 'title')?.name).toBe('Updated Title');
			expect(store.get('posts', 'title')?.icon).toBe('📝');
		});
	});

	describe('delete (soft)', () => {
		test('soft-deletes a field', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.delete('posts', 'title');

			const field = store.get('posts', 'title');
			expect(field).toBeDefined();
			expect(field?.deletedAt).toBeGreaterThan(0);
		});

		test('no-op for non-existent field', () => {
			const { store } = createTestStore();
			expect(() => store.delete('posts', 'unknown')).not.toThrow();
		});

		test('excludes deleted fields from order calculation', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' }); // order: 1
			store.create('posts', 'body', { name: 'Body', type: 'text' }); // order: 2
			store.delete('posts', 'body');
			store.create('posts', 'summary', { name: 'Summary', type: 'text' }); // order: 2 (not 3)

			expect(store.get('posts', 'summary')?.order).toBe(2);
		});
	});

	describe('rename', () => {
		test('renames a field', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.rename('posts', 'title', 'Headline');

			expect(store.get('posts', 'title')?.name).toBe('Headline');
		});

		test('throws for non-existent field', () => {
			const { store } = createTestStore();
			expect(() => store.rename('posts', 'unknown', 'New Name')).toThrow(
				'Field "unknown" not found in table "posts"',
			);
		});
	});

	describe('reorder', () => {
		test('reorders a field', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.create('posts', 'body', { name: 'Body', type: 'text' });
			store.create('posts', 'date', { name: 'Date', type: 'date' });

			// Move date between title and body
			store.reorder('posts', 'date', 1.5);

			const fields = store.getActiveByTable('posts');
			expect(fields.map((f) => f.id)).toEqual(['title', 'date', 'body']);
		});

		test('throws for non-existent field', () => {
			const { store } = createTestStore();
			expect(() => store.reorder('posts', 'unknown', 1)).toThrow(
				'Field "unknown" not found in table "posts"',
			);
		});
	});

	describe('restore', () => {
		test('restores a soft-deleted field', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.delete('posts', 'title');
			expect(store.get('posts', 'title')?.deletedAt).not.toBeNull();

			store.restore('posts', 'title');
			expect(store.get('posts', 'title')?.deletedAt).toBeNull();
		});

		test('no-op for active field', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.restore('posts', 'title');
			expect(store.get('posts', 'title')?.deletedAt).toBeNull();
		});

		test('throws for non-existent field', () => {
			const { store } = createTestStore();
			expect(() => store.restore('posts', 'unknown')).toThrow(
				'Field "unknown" not found in table "posts"',
			);
		});
	});

	describe('getByTable', () => {
		test('returns fields sorted by order', () => {
			const { store } = createTestStore();
			store.create('posts', 'date', { name: 'Date', type: 'date', order: 3 });
			store.create('posts', 'title', { name: 'Title', type: 'text', order: 1 });
			store.create('posts', 'body', { name: 'Body', type: 'text', order: 2 });

			const fields = store.getByTable('posts');
			expect(fields.map((f) => f.id)).toEqual(['title', 'body', 'date']);
		});

		test('includes soft-deleted fields', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.create('posts', 'body', { name: 'Body', type: 'text' });
			store.delete('posts', 'title');

			const fields = store.getByTable('posts');
			expect(fields).toHaveLength(2);
		});

		test('uses fieldId as tiebreaker for equal orders', () => {
			const { store } = createTestStore();
			store.create('posts', 'beta', { name: 'Beta', type: 'text', order: 1 });
			store.create('posts', 'alpha', { name: 'Alpha', type: 'text', order: 1 });

			const fields = store.getByTable('posts');
			expect(fields.map((f) => f.id)).toEqual(['alpha', 'beta']);
		});

		test('returns empty array for non-existent table', () => {
			const { store } = createTestStore();
			expect(store.getByTable('unknown')).toEqual([]);
		});

		test('returns only fields for specified table', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Post Title', type: 'text' });
			store.create('pages', 'title', { name: 'Page Title', type: 'text' });

			const postFields = store.getByTable('posts');
			expect(postFields).toHaveLength(1);
			expect(postFields[0]!.field.name).toBe('Post Title');
		});
	});

	describe('getActiveByTable', () => {
		test('excludes soft-deleted fields', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });
			store.create('posts', 'body', { name: 'Body', type: 'text' });
			store.delete('posts', 'title');

			const fields = store.getActiveByTable('posts');
			expect(fields).toHaveLength(1);
			expect(fields[0]!.id).toBe('body');
		});
	});

	describe('observe', () => {
		test('notifies on field creation', () => {
			const { store } = createTestStore();
			const changes: unknown[] = [];
			store.observe((events) => changes.push(...events));

			store.create('posts', 'title', { name: 'Title', type: 'text' });

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				type: 'add',
				key: 'posts:title',
				value: { name: 'Title', type: 'text' },
			});
		});

		test('notifies on field update', () => {
			const { store } = createTestStore();
			store.create('posts', 'title', { name: 'Title', type: 'text' });

			const changes: unknown[] = [];
			store.observe((events) => changes.push(...events));

			store.rename('posts', 'title', 'Headline');

			expect(changes).toHaveLength(1);
			expect(changes[0]).toMatchObject({
				type: 'update',
				key: 'posts:title',
				previousValue: { name: 'Title' },
				value: { name: 'Headline' },
			});
		});

		test('unsubscribe stops notifications', () => {
			const { store } = createTestStore();
			const changes: unknown[] = [];
			const unsubscribe = store.observe((events) => changes.push(...events));

			store.create('posts', 'title', { name: 'Title', type: 'text' });
			expect(changes).toHaveLength(1);

			unsubscribe();
			store.create('posts', 'body', { name: 'Body', type: 'text' });
			expect(changes).toHaveLength(1);
		});
	});
});
