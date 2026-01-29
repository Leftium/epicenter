import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import {
	boolean,
	id,
	integer,
	richtext,
	select,
	table,
	tags,
	text,
} from '../schema';
import { createTables } from './create-tables';

/**
 * Type inference test file for YjsDoc
 * This file tests that generics properly flow through the API
 * Hover over variables to verify types are correctly inferred
 */

describe('YjsDoc Type Inference', () => {
	test('should infer row types from definition', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			posts: table('posts', {
				name: '',
				fields: [
					id(),
					text('title'),
					richtext('content'),
					tags('tags', { options: ['tech', 'personal', 'work'] as const }),
					integer('view_count'),
					boolean('published'),
				] as const,
			}),
		});

		// Test upsert() - accepts plain values (strings for richtext, arrays for tags)
		doc.get('posts').upsert({
			id: '1',
			title: 'Test Post',
			content: 'rtxt_abc123', // richtext stores ID reference
			tags: ['tech'], // tags stores plain array
			view_count: 0,
			published: false,
		});

		// Test get() - returns GetResult<Row>
		const result = doc.get('posts').get('1');
		expect(result.status).toBe('valid');

		if (result.status === 'valid') {
			const row = result.row;
			// Verify property access works
			expect(row.id).toBe('1');
			expect(row.title).toBe('Test Post');
			expect(row.view_count).toBe(0);
			expect(row.published).toBe(false);

			// Verify plain types are returned (no embedded CRDTs)
			expect(row.content).toBe('rtxt_abc123');
			expect(row.tags).toEqual(['tech']);
		}
	});

	test('should infer types for getAll()', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			products: table('products', {
				name: '',
				fields: [
					id(),
					text('name'),
					integer('price'),
					boolean('in_stock'),
				] as const,
			}),
		});

		doc.get('products').upsertMany([
			{ id: '1', name: 'Widget', price: 1000, in_stock: true },
			{ id: '2', name: 'Gadget', price: 2000, in_stock: false },
		]);

		// getAllValid() returns Row[] directly
		const products = doc.get('products').getAllValid();
		// Expected type: Array<{ id: string; name: string; price: number; in_stock: boolean }>

		expect(products).toHaveLength(2);
	});

	test('should infer predicate parameter types in filter()', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			tasks: table('tasks', {
				name: '',
				fields: [
					id(),
					text('title'),
					boolean('completed'),
					select('priority', { options: ['low', 'medium', 'high'] as const }),
				] as const,
			}),
		});

		doc.get('tasks').upsertMany([
			{ id: '1', title: 'Task 1', completed: false, priority: 'high' },
			{ id: '2', title: 'Task 2', completed: true, priority: 'low' },
		]);

		// Hover over 'task' parameter to verify inferred type
		// filter() now returns Row[] directly
		const incompleteTasks = doc.get('tasks').filter((task) => !task.completed);
		// task type should be: { id: string; title: string; completed: boolean; priority: string }

		expect(incompleteTasks).toHaveLength(1);
		expect(incompleteTasks[0]?.title).toBe('Task 1');
	});

	test('should infer predicate parameter types in find()', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			items: table('items', {
				name: '',
				fields: [id(), text('name'), integer('quantity')] as const,
			}),
		});

		doc.get('items').upsertMany([
			{ id: '1', name: 'Item 1', quantity: 5 },
			{ id: '2', name: 'Item 2', quantity: 0 },
		]);

		// Hover over 'item' parameter to verify inferred type
		// find() now returns Row | null directly
		const outOfStockItem = doc.get('items').find((item) => item.quantity === 0);
		// item type should be: { id: string; name: string; quantity: number }

		expect(outOfStockItem).not.toBeNull();
		expect(outOfStockItem?.name).toBe('Item 2');
	});

	test('should infer observer handler parameter types', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			notifications: table('notifications', {
				name: '',
				fields: [id(), text('message'), boolean('read')] as const,
			}),
		});

		const addedNotifications: Array<{
			id: string;
			message: string;
			read: boolean;
		}> = [];

		const unsubscribe = doc.get('notifications').observe((changedIds) => {
			for (const id of changedIds) {
				const result = doc.get('notifications').get(id);
				if (result.status === 'valid') {
					addedNotifications.push(result.row);
				}
			}
		});

		doc.get('notifications').upsert({
			id: '1',
			message: 'Test notification',
			read: false,
		});

		expect(addedNotifications).toHaveLength(1);
		expect(addedNotifications[0]?.message).toBe('Test notification');

		unsubscribe();
	});

	test('should handle nullable richtext types correctly', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			articles: table('articles', {
				name: '',
				fields: [
					id(),
					text('title'),
					richtext('description'), // string | null
					richtext('content'), // string | null
				] as const,
			}),
		});

		// Test with null values
		doc.get('articles').upsert({
			id: '1',
			title: 'Article without content',
			description: null,
			content: null,
		});

		const article1Result = doc.get('articles').get('1');
		expect(article1Result.status).toBe('valid');
		if (article1Result.status === 'valid') {
			expect(article1Result.row.description).toBeNull();
			expect(article1Result.row.content).toBeNull();
		}

		// Test with string ID values
		doc.get('articles').upsert({
			id: '2',
			title: 'Article with content',
			description: 'rtxt_desc123',
			content: 'rtxt_content456',
		});

		const article2Result = doc.get('articles').get('2');
		expect(article2Result.status).toBe('valid');
		if (article2Result.status === 'valid') {
			expect(article2Result.row.description).toBe('rtxt_desc123');
			expect(article2Result.row.content).toBe('rtxt_content456');
		}
	});

	test('should handle multi-table definitions with proper type inference', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			authors: table('authors', {
				name: '',
				fields: [id(), text('name'), richtext('bio')] as const,
			}),
			books: table('books', {
				name: '',
				fields: [
					id(),
					text('author_id'),
					text('title'),
					tags('chapters', {
						options: ['Chapter 1', 'Chapter 2', 'Chapter 3'] as const,
					}),
					boolean('published'),
				] as const,
			}),
		});

		// Test authors table - richtext stores ID reference
		doc.get('authors').upsert({
			id: 'author-1',
			name: 'John Doe',
			bio: 'rtxt_bio123',
		});

		const authorResult = doc.get('authors').get('author-1');
		// Hover to verify type: GetResult<{ id: string; name: string; bio: string | null }>

		// Test books table - tags stores plain array
		doc.get('books').upsert({
			id: 'book-1',
			author_id: 'author-1',
			title: 'My Book',
			chapters: ['Chapter 1', 'Chapter 2'],
			published: true,
		});

		const bookResult = doc.get('books').get('book-1');
		// Hover to verify type: GetResult<{ id: string; author_id: string; title: string; chapters: string[]; published: boolean }>

		expect(authorResult.status).toBe('valid');
		expect(bookResult.status).toBe('valid');
		if (authorResult.status === 'valid') {
			expect(authorResult.row.name).toBe('John Doe');
		}
		if (bookResult.status === 'valid') {
			expect(bookResult.row.title).toBe('My Book');
		}
	});

	test('should properly type upsertMany with array of rows', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			comments: table('comments', {
				name: '',
				fields: [id(), text('text'), integer('upvotes')] as const,
			}),
		});

		// Hover over the array to verify element type
		const commentsToAdd = [
			{ id: '1', text: 'First comment', upvotes: 5 },
			{ id: '2', text: 'Second comment', upvotes: 10 },
		];

		doc.get('comments').upsertMany(commentsToAdd);

		const comments = doc.get('comments').getAllValid();
		expect(comments).toHaveLength(2);
	});

	test('should handle richtext and tags in complex scenarios', () => {
		const doc = createTables(new Y.Doc({ guid: 'test-workspace' }), {
			documents: table('documents', {
				name: '',
				fields: [
					id(),
					text('title'),
					richtext('body'),
					richtext('notes'),
					tags('tags', { options: ['tag1', 'tag2'] as const }),
				] as const,
			}),
		});

		// Upsert with plain values (richtext stores ID, tags stores array)
		doc.get('documents').upsert({
			id: 'doc-1',
			title: 'My Document',
			body: 'rtxt_body123',
			notes: null,
			tags: ['tag1', 'tag2'],
		});

		// Test retrieval
		const retrievedResult = doc.get('documents').get('doc-1');
		expect(retrievedResult.status).toBe('valid');

		if (retrievedResult.status === 'valid') {
			const retrieved = retrievedResult.row;
			// These should all be plain types (no embedded CRDTs)
			expect(retrieved.body).toBe('rtxt_body123');
			expect(retrieved.tags).toEqual(['tag1', 'tag2']);
			expect(retrieved.notes).toBeNull();
		}
	});
});
