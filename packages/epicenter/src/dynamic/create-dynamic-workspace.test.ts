import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createDynamicWorkspace } from './create-dynamic-workspace.js';

describe('createDynamicWorkspace', () => {
	describe('initialization', () => {
		test('creates workspace with specified id', () => {
			const workspace = createDynamicWorkspace({ id: 'test-workspace' });
			expect(workspace.id).toBe('test-workspace');
		});

		test('creates Y.Doc with workspace id as guid', () => {
			const workspace = createDynamicWorkspace({ id: 'test-workspace' });
			expect(workspace.ydoc.guid).toBe('test-workspace');
		});

		test('uses provided Y.Doc when specified', () => {
			const ydoc = new Y.Doc({ guid: 'custom-guid' });
			const workspace = createDynamicWorkspace({ id: 'test', ydoc });

			expect(workspace.ydoc).toBe(ydoc);
			expect(workspace.ydoc.guid).toBe('custom-guid');
		});

		test('exposes all stores', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			expect(workspace.tables).toBeDefined();
			expect(workspace.fields).toBeDefined();
			expect(workspace.rows).toBeDefined();
			expect(workspace.cells).toBeDefined();
		});
	});

	describe('integration - full workflow', () => {
		test('creates table, fields, rows, and cells', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			// Create table
			workspace.tables.create('posts', { name: 'Blog Posts', icon: '📝' });

			// Add fields
			workspace.fields.create('posts', 'title', {
				name: 'Title',
				type: 'text',
			});
			workspace.fields.create('posts', 'published', {
				name: 'Published',
				type: 'boolean',
			});
			workspace.fields.create('posts', 'views', {
				name: 'Views',
				type: 'integer',
				default: 0,
			});

			// Add rows
			const row1 = workspace.rows.create('posts');
			const row2 = workspace.rows.create('posts');

			// Set cell values
			workspace.cells.set('posts', row1, 'title', 'First Post');
			workspace.cells.set('posts', row1, 'published', true);
			workspace.cells.set('posts', row1, 'views', 100);

			workspace.cells.set('posts', row2, 'title', 'Second Post');
			workspace.cells.set('posts', row2, 'published', false);

			// Verify table
			const table = workspace.getTableWithFields('posts');
			expect(table).not.toBeNull();
			expect(table!.name).toBe('Blog Posts');
			expect(table!.icon).toBe('📝');
			expect(table!.fields).toHaveLength(3);
			expect(table!.fields.map((f) => f.id)).toEqual([
				'title',
				'published',
				'views',
			]);

			// Verify rows with cells
			const rows = workspace.getRowsWithCells('posts');
			expect(rows).toHaveLength(2);

			const firstRow = rows.find((r) => r.id === row1);
			expect(firstRow).toBeDefined();
			expect(firstRow!.cells.title).toBe('First Post');
			expect(firstRow!.cells.published).toBe(true);
			expect(firstRow!.cells.views).toBe(100);

			const secondRow = rows.find((r) => r.id === row2);
			expect(secondRow).toBeDefined();
			expect(secondRow!.cells.title).toBe('Second Post');
			expect(secondRow!.cells.published).toBe(false);
			expect(secondRow!.cells.views).toBeUndefined();
		});

		test('handles soft delete correctly', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			// Setup
			workspace.tables.create('posts', { name: 'Posts' });
			workspace.fields.create('posts', 'title', {
				name: 'Title',
				type: 'text',
			});
			workspace.fields.create('posts', 'body', { name: 'Body', type: 'text' });
			const rowId = workspace.rows.create('posts');
			workspace.cells.set('posts', rowId, 'title', 'Hello');
			workspace.cells.set('posts', rowId, 'body', 'World');

			// Delete a field
			workspace.fields.delete('posts', 'body');

			// Verify field is excluded from table view
			const table = workspace.getTableWithFields('posts');
			expect(table!.fields).toHaveLength(1);
			expect(table!.fields[0]!.id).toBe('title');

			// Cell data still exists but not included in getRowsWithCells
			const rows = workspace.getRowsWithCells('posts');
			expect(rows[0]!.cells.title).toBe('Hello');
			expect(rows[0]!.cells.body).toBeUndefined(); // Not included (field deleted)

			// Raw cell still exists
			expect(workspace.cells.get('posts', rowId, 'body')).toBe('World');

			// Restore field
			workspace.fields.restore('posts', 'body');

			// Now cell reappears
			const rowsAfter = workspace.getRowsWithCells('posts');
			expect(rowsAfter[0]!.cells.body).toBe('World');
		});

		test('returns null for non-existent or deleted table', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			expect(workspace.getTableWithFields('unknown')).toBeNull();

			workspace.tables.create('posts', { name: 'Posts' });
			workspace.tables.delete('posts');

			expect(workspace.getTableWithFields('posts')).toBeNull();
		});
	});

	describe('batch', () => {
		test('groups multiple operations into single transaction', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			// Track observer calls
			let observerCallCount = 0;
			workspace.tables.observe(() => {
				observerCallCount++;
			});

			// Without batch: each operation triggers observer
			workspace.tables.create('table1', { name: 'Table 1' });
			workspace.tables.create('table2', { name: 'Table 2' });
			expect(observerCallCount).toBe(2);

			// Reset counter
			observerCallCount = 0;

			// With batch: all operations trigger observer once
			workspace.batch((ws) => {
				ws.tables.create('table3', { name: 'Table 3' });
				ws.tables.create('table4', { name: 'Table 4' });
				ws.tables.create('table5', { name: 'Table 5' });
			});
			expect(observerCallCount).toBe(1);
		});

		test('batch returns result from callback', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			const result = workspace.batch((ws) => {
				ws.tables.create('posts', { name: 'Posts' });
				return ws.rows.create('posts');
			});

			expect(result).toHaveLength(12); // nanoid length
			expect(workspace.rows.has('posts', result)).toBe(true);
		});

		test('batch enables efficient bulk import', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			workspace.tables.create('contacts', { name: 'Contacts' });
			workspace.fields.create('contacts', 'name', {
				name: 'Name',
				type: 'text',
			});
			workspace.fields.create('contacts', 'email', {
				name: 'Email',
				type: 'text',
			});

			const testData = [
				{ name: 'Alice', email: 'alice@example.com' },
				{ name: 'Bob', email: 'bob@example.com' },
				{ name: 'Charlie', email: 'charlie@example.com' },
			];

			// Bulk import with batch
			const rowIds = workspace.batch((ws) => {
				return testData.map((contact) => {
					const rowId = ws.rows.create('contacts');
					ws.cells.set('contacts', rowId, 'name', contact.name);
					ws.cells.set('contacts', rowId, 'email', contact.email);
					return rowId;
				});
			});

			expect(rowIds).toHaveLength(3);

			const rows = workspace.getRowsWithCells('contacts');
			expect(rows).toHaveLength(3);
			expect(rows.map((r) => r.cells.name)).toEqual([
				'Alice',
				'Bob',
				'Charlie',
			]);
		});
	});

	describe('getTableWithFields', () => {
		test('returns fields sorted by order', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			workspace.tables.create('posts', { name: 'Posts' });
			workspace.fields.create('posts', 'c', {
				name: 'C',
				type: 'text',
				order: 3,
			});
			workspace.fields.create('posts', 'a', {
				name: 'A',
				type: 'text',
				order: 1,
			});
			workspace.fields.create('posts', 'b', {
				name: 'B',
				type: 'text',
				order: 2,
			});

			const table = workspace.getTableWithFields('posts');
			expect(table!.fields.map((f) => f.id)).toEqual(['a', 'b', 'c']);
		});

		test('excludes deleted fields', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			workspace.tables.create('posts', { name: 'Posts' });
			workspace.fields.create('posts', 'title', {
				name: 'Title',
				type: 'text',
			});
			workspace.fields.create('posts', 'body', { name: 'Body', type: 'text' });
			workspace.fields.delete('posts', 'body');

			const table = workspace.getTableWithFields('posts');
			expect(table!.fields).toHaveLength(1);
			expect(table!.fields[0]!.id).toBe('title');
		});

		test('includes field options and default', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			workspace.tables.create('posts', { name: 'Posts' });
			workspace.fields.create('posts', 'status', {
				name: 'Status',
				type: 'select',
				options: ['draft', 'published'],
				default: 'draft',
			});

			const table = workspace.getTableWithFields('posts');
			expect(table!.fields[0]!.options).toEqual(['draft', 'published']);
			expect(table!.fields[0]!.default).toBe('draft');
		});
	});

	describe('getRowsWithCells', () => {
		test('returns rows sorted by order', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			workspace.tables.create('posts', { name: 'Posts' });
			workspace.fields.create('posts', 'title', {
				name: 'Title',
				type: 'text',
			});

			workspace.rows.create('posts', 'row-c', 3);
			workspace.rows.create('posts', 'row-a', 1);
			workspace.rows.create('posts', 'row-b', 2);

			const rows = workspace.getRowsWithCells('posts');
			expect(rows.map((r) => r.id)).toEqual(['row-a', 'row-b', 'row-c']);
		});

		test('excludes deleted rows', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			workspace.tables.create('posts', { name: 'Posts' });
			workspace.fields.create('posts', 'title', {
				name: 'Title',
				type: 'text',
			});

			const row1 = workspace.rows.create('posts');
			const row2 = workspace.rows.create('posts');
			workspace.rows.delete('posts', row1);

			const rows = workspace.getRowsWithCells('posts');
			expect(rows).toHaveLength(1);
			expect(rows[0]!.id).toBe(row2);
		});

		test('only includes cells for active fields', () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			workspace.tables.create('posts', { name: 'Posts' });
			workspace.fields.create('posts', 'title', {
				name: 'Title',
				type: 'text',
			});
			workspace.fields.create('posts', 'body', { name: 'Body', type: 'text' });

			const rowId = workspace.rows.create('posts');
			workspace.cells.set('posts', rowId, 'title', 'Hello');
			workspace.cells.set('posts', rowId, 'body', 'World');

			// Delete body field
			workspace.fields.delete('posts', 'body');

			const rows = workspace.getRowsWithCells('posts');
			expect(Object.keys(rows[0]!.cells)).toEqual(['title']);
		});
	});

	describe('destroy', () => {
		test('destroys Y.Doc', async () => {
			const workspace = createDynamicWorkspace({ id: 'test' });

			await workspace.destroy();

			// Y.Doc should be destroyed
			expect(workspace.ydoc.isDestroyed).toBe(true);
		});
	});

	describe('CRDT sync', () => {
		test('syncs between two workspaces', () => {
			// Create two workspaces with separate Y.Docs
			const doc1 = new Y.Doc({ guid: 'shared' });
			const doc2 = new Y.Doc({ guid: 'shared' });

			const ws1 = createDynamicWorkspace({ id: 'shared', ydoc: doc1 });
			const ws2 = createDynamicWorkspace({ id: 'shared', ydoc: doc2 });

			// Make changes on ws1
			ws1.tables.create('posts', { name: 'Posts' });
			ws1.fields.create('posts', 'title', { name: 'Title', type: 'text' });

			// Sync doc1 -> doc2
			const update = Y.encodeStateAsUpdate(doc1);
			Y.applyUpdate(doc2, update);

			// ws2 should see the changes
			expect(ws2.tables.get('posts')).toBeDefined();
			expect(ws2.fields.get('posts', 'title')).toBeDefined();

			// Make changes on ws2
			const rowId = ws2.rows.create('posts');
			ws2.cells.set('posts', rowId, 'title', 'Hello from ws2');

			// Sync doc2 -> doc1
			const update2 = Y.encodeStateAsUpdate(doc2);
			Y.applyUpdate(doc1, update2);

			// ws1 should see ws2's changes
			expect(ws1.rows.has('posts', rowId)).toBe(true);
			expect(ws1.cells.get('posts', rowId, 'title')).toBe('Hello from ws2');
		});
	});
});
