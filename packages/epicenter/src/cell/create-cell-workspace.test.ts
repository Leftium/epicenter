import { describe, test, expect, beforeEach } from 'bun:test';
import * as Y from 'yjs';
import { createCellWorkspace } from './create-cell-workspace';
import type { CellWorkspaceClient, SchemaTableDefinition } from './types';

describe('createCellWorkspace', () => {
	let workspace: CellWorkspaceClient;

	beforeEach(() => {
		workspace = createCellWorkspace({ id: 'test-workspace' });
	});

	describe('basic functionality', () => {
		test('creates workspace with id and ydoc', () => {
			expect(workspace.id).toBe('test-workspace');
			expect(workspace.ydoc).toBeInstanceOf(Y.Doc);
			expect(workspace.ydoc.guid).toBe('test-workspace');
		});

		test('can use existing ydoc', () => {
			const existingYdoc = new Y.Doc({ guid: 'custom-guid' });
			const ws = createCellWorkspace({ id: 'test', ydoc: existingYdoc });
			expect(ws.ydoc).toBe(existingYdoc);
		});
	});

	describe('rows store', () => {
		test('creates row with auto-generated id', () => {
			const rowId = workspace.rows.create('posts');
			expect(rowId).toHaveLength(12);
			expect(workspace.rows.has('posts', rowId)).toBe(true);
		});

		test('creates row with custom id', () => {
			const rowId = workspace.rows.create('posts', 'custom-id');
			expect(rowId).toBe('custom-id');
			expect(workspace.rows.has('posts', 'custom-id')).toBe(true);
		});

		test('auto-assigns order', () => {
			const row1 = workspace.rows.create('posts');
			const row2 = workspace.rows.create('posts');
			const row3 = workspace.rows.create('posts');

			expect(workspace.rows.get('posts', row1)?.order).toBe(1);
			expect(workspace.rows.get('posts', row2)?.order).toBe(2);
			expect(workspace.rows.get('posts', row3)?.order).toBe(3);
		});

		test('creates row with custom order', () => {
			const rowId = workspace.rows.create('posts', 'row1', 100);
			expect(workspace.rows.get('posts', rowId)?.order).toBe(100);
		});

		test('soft-deletes row', () => {
			const rowId = workspace.rows.create('posts');
			workspace.rows.delete('posts', rowId);

			const meta = workspace.rows.get('posts', rowId);
			expect(meta?.deletedAt).not.toBeNull();
		});

		test('restores soft-deleted row', () => {
			const rowId = workspace.rows.create('posts');
			workspace.rows.delete('posts', rowId);
			workspace.rows.restore('posts', rowId);

			const meta = workspace.rows.get('posts', rowId);
			expect(meta?.deletedAt).toBeNull();
		});

		test('getByTable returns all rows sorted by order', () => {
			workspace.rows.create('posts', 'row3', 3);
			workspace.rows.create('posts', 'row1', 1);
			workspace.rows.create('posts', 'row2', 2);

			const rows = workspace.rows.getByTable('posts');
			expect(rows.map((r) => r.id)).toEqual(['row1', 'row2', 'row3']);
		});

		test('getActiveByTable excludes soft-deleted rows', () => {
			const row1 = workspace.rows.create('posts', 'row1');
			workspace.rows.create('posts', 'row2');
			workspace.rows.delete('posts', row1);

			const active = workspace.rows.getActiveByTable('posts');
			expect(active.map((r) => r.id)).toEqual(['row2']);
		});

		test('reorders row', () => {
			const rowId = workspace.rows.create('posts', 'row1', 1);
			workspace.rows.reorder('posts', rowId, 100);
			expect(workspace.rows.get('posts', rowId)?.order).toBe(100);
		});

		test('validates tableId does not contain colon', () => {
			expect(() => workspace.rows.create('invalid:table')).toThrow(
				"tableId cannot contain ':' character",
			);
		});

		test('validates rowId does not contain colon', () => {
			expect(() =>
				workspace.rows.create('posts', 'invalid:id'),
			).toThrow("rowId cannot contain ':' character");
		});
	});

	describe('cells store', () => {
		test('sets and gets cell value', () => {
			workspace.cells.set('posts', 'row1', 'title', 'Hello World');
			expect(workspace.cells.get('posts', 'row1', 'title')).toBe(
				'Hello World',
			);
		});

		test('deletes cell value', () => {
			workspace.cells.set('posts', 'row1', 'title', 'Hello');
			workspace.cells.delete('posts', 'row1', 'title');
			expect(workspace.cells.has('posts', 'row1', 'title')).toBe(false);
		});

		test('getByRow returns all cells for a row', () => {
			workspace.cells.set('posts', 'row1', 'title', 'Hello');
			workspace.cells.set('posts', 'row1', 'views', 100);
			workspace.cells.set('posts', 'row1', 'published', true);

			const cells = workspace.cells.getByRow('posts', 'row1');
			expect(cells.size).toBe(3);
			expect(cells.get('title')).toBe('Hello');
			expect(cells.get('views')).toBe(100);
			expect(cells.get('published')).toBe(true);
		});

		test('getByRowFields returns specific fields', () => {
			workspace.cells.set('posts', 'row1', 'title', 'Hello');
			workspace.cells.set('posts', 'row1', 'views', 100);
			workspace.cells.set('posts', 'row1', 'published', true);

			const cells = workspace.cells.getByRowFields('posts', 'row1', [
				'title',
				'views',
			]);
			expect(cells.size).toBe(2);
			expect(cells.get('title')).toBe('Hello');
			expect(cells.get('views')).toBe(100);
			expect(cells.has('published')).toBe(false);
		});

		test('stores various data types', () => {
			workspace.cells.set('posts', 'row1', 'text', 'hello');
			workspace.cells.set('posts', 'row1', 'number', 42);
			workspace.cells.set('posts', 'row1', 'float', 3.14);
			workspace.cells.set('posts', 'row1', 'bool', true);
			workspace.cells.set('posts', 'row1', 'array', ['a', 'b']);
			workspace.cells.set('posts', 'row1', 'object', { nested: 'value' });
			workspace.cells.set('posts', 'row1', 'null', null);

			expect(workspace.cells.get('posts', 'row1', 'text')).toBe('hello');
			expect(workspace.cells.get('posts', 'row1', 'number')).toBe(42);
			expect(workspace.cells.get('posts', 'row1', 'float')).toBe(3.14);
			expect(workspace.cells.get('posts', 'row1', 'bool')).toBe(true);
			expect(workspace.cells.get('posts', 'row1', 'array')).toEqual([
				'a',
				'b',
			]);
			expect(workspace.cells.get('posts', 'row1', 'object')).toEqual({
				nested: 'value',
			});
			expect(workspace.cells.get('posts', 'row1', 'null')).toBeNull();
		});

		test('validates fieldId does not contain colon', () => {
			expect(() =>
				workspace.cells.set('posts', 'row1', 'invalid:field', 'value'),
			).toThrow("fieldId cannot contain ':' character");
		});
	});

	describe('kv store', () => {
		test('sets and gets value', () => {
			workspace.kv.set('theme', 'dark');
			expect(workspace.kv.get('theme')).toBe('dark');
		});

		test('deletes value', () => {
			workspace.kv.set('theme', 'dark');
			workspace.kv.delete('theme');
			expect(workspace.kv.has('theme')).toBe(false);
		});

		test('getAll returns all values', () => {
			workspace.kv.set('theme', 'dark');
			workspace.kv.set('language', 'en');

			const all = workspace.kv.getAll();
			expect(all.size).toBe(2);
			expect(all.get('theme')).toBe('dark');
			expect(all.get('language')).toBe('en');
		});
	});

	describe('getRowsWithCells', () => {
		test('returns rows with their cell values', () => {
			const row1 = workspace.rows.create('posts');
			const row2 = workspace.rows.create('posts');

			workspace.cells.set('posts', row1, 'title', 'First Post');
			workspace.cells.set('posts', row1, 'views', 100);
			workspace.cells.set('posts', row2, 'title', 'Second Post');

			const rows = workspace.getRowsWithCells('posts');

			expect(rows).toHaveLength(2);
			expect(rows[0]!.id).toBe(row1);
			expect(rows[0]!.cells).toEqual({ title: 'First Post', views: 100 });
			expect(rows[1]!.id).toBe(row2);
			expect(rows[1]!.cells).toEqual({ title: 'Second Post' });
		});

		test('excludes soft-deleted rows', () => {
			const row1 = workspace.rows.create('posts');
			const row2 = workspace.rows.create('posts');
			workspace.cells.set('posts', row1, 'title', 'First');
			workspace.cells.set('posts', row2, 'title', 'Second');

			workspace.rows.delete('posts', row1);

			const rows = workspace.getRowsWithCells('posts');
			expect(rows).toHaveLength(1);
			expect(rows[0]!.cells.title).toBe('Second');
		});
	});

	describe('getTypedRowsWithCells', () => {
		const postsSchema: SchemaTableDefinition = {
			name: 'Blog Posts',
			fields: {
				title: { name: 'Title', type: 'text', order: 1 },
				views: { name: 'Views', type: 'integer', order: 2 },
				published: { name: 'Published', type: 'boolean', order: 3 },
			},
		};

		test('validates cell types against schema', () => {
			const rowId = workspace.rows.create('posts');
			workspace.cells.set('posts', rowId, 'title', 'Hello');
			workspace.cells.set('posts', rowId, 'views', 100);
			workspace.cells.set('posts', rowId, 'published', true);

			const rows = workspace.getTypedRowsWithCells('posts', postsSchema);
			expect(rows).toHaveLength(1);

			const row = rows[0]!;
			expect(row.cells.title).toEqual({
				value: 'Hello',
				type: 'text',
				valid: true,
			});
			expect(row.cells.views).toEqual({
				value: 100,
				type: 'integer',
				valid: true,
			});
			expect(row.cells.published).toEqual({
				value: true,
				type: 'boolean',
				valid: true,
			});
		});

		test('marks type mismatches as invalid', () => {
			const rowId = workspace.rows.create('posts');
			workspace.cells.set('posts', rowId, 'title', 123); // Should be text
			workspace.cells.set('posts', rowId, 'views', 'not a number'); // Should be integer
			workspace.cells.set('posts', rowId, 'published', 'yes'); // Should be boolean

			const rows = workspace.getTypedRowsWithCells('posts', postsSchema);
			const row = rows[0]!;

			expect(row.cells.title!.valid).toBe(false);
			expect(row.cells.views!.valid).toBe(false);
			expect(row.cells.published!.valid).toBe(false);
		});

		test('identifies missing fields', () => {
			const rowId = workspace.rows.create('posts');
			workspace.cells.set('posts', rowId, 'title', 'Hello');
			// views and published are missing

			const rows = workspace.getTypedRowsWithCells('posts', postsSchema);
			const row = rows[0]!;

			expect(row.missingFields).toContain('views');
			expect(row.missingFields).toContain('published');
			expect(row.missingFields).not.toContain('title');
		});

		test('identifies extra fields not in schema', () => {
			const rowId = workspace.rows.create('posts');
			workspace.cells.set('posts', rowId, 'title', 'Hello');
			workspace.cells.set('posts', rowId, 'unknownField', 'value');
			workspace.cells.set('posts', rowId, 'anotherExtra', 42);

			const rows = workspace.getTypedRowsWithCells('posts', postsSchema);
			const row = rows[0]!;

			expect(row.extraFields).toContain('unknownField');
			expect(row.extraFields).toContain('anotherExtra');
			expect(row.extraFields).not.toContain('title');
		});

		test('handles null/undefined values as valid', () => {
			const rowId = workspace.rows.create('posts');
			workspace.cells.set('posts', rowId, 'title', null);

			const rows = workspace.getTypedRowsWithCells('posts', postsSchema);
			const row = rows[0]!;

			expect(row.cells.title!.valid).toBe(true);
			expect(row.cells.title!.value).toBeNull();
		});
	});

	describe('CRDT sync behavior', () => {
		test('syncs between two workspaces', () => {
			const ws1 = createCellWorkspace({ id: 'sync-test' });
			const ws2 = createCellWorkspace({ id: 'sync-test' });

			// Create row in ws1
			const rowId = ws1.rows.create('posts', 'row1');
			ws1.cells.set('posts', rowId, 'title', 'Hello from WS1');

			// Sync ws1 -> ws2
			const update1 = Y.encodeStateAsUpdate(ws1.ydoc);
			Y.applyUpdate(ws2.ydoc, update1);

			// Verify ws2 has the data
			expect(ws2.rows.has('posts', 'row1')).toBe(true);
			expect(ws2.cells.get('posts', 'row1', 'title')).toBe(
				'Hello from WS1',
			);

			// Make change in ws2
			ws2.cells.set('posts', rowId, 'title', 'Updated in WS2');

			// Sync ws2 -> ws1
			const update2 = Y.encodeStateAsUpdate(ws2.ydoc);
			Y.applyUpdate(ws1.ydoc, update2);

			// Verify ws1 has the update
			expect(ws1.cells.get('posts', 'row1', 'title')).toBe(
				'Updated in WS2',
			);
		});

		test('last-write-wins for concurrent edits', async () => {
			const ws1 = createCellWorkspace({ id: 'lww-test' });
			const ws2 = createCellWorkspace({ id: 'lww-test' });

			// Both create the same row
			ws1.rows.create('posts', 'row1');
			ws1.cells.set('posts', 'row1', 'title', 'From WS1');

			// Small delay to ensure different timestamps
			await new Promise((resolve) => setTimeout(resolve, 2));

			ws2.rows.create('posts', 'row1');
			ws2.cells.set('posts', 'row1', 'title', 'From WS2 (later)');

			// Sync both ways
			const update1 = Y.encodeStateAsUpdate(ws1.ydoc);
			const update2 = Y.encodeStateAsUpdate(ws2.ydoc);
			Y.applyUpdate(ws2.ydoc, update1);
			Y.applyUpdate(ws1.ydoc, update2);

			// Both should have the later value (WS2)
			expect(ws1.cells.get('posts', 'row1', 'title')).toBe(
				'From WS2 (later)',
			);
			expect(ws2.cells.get('posts', 'row1', 'title')).toBe(
				'From WS2 (later)',
			);
		});
	});

	describe('observers', () => {
		test('rows observer fires on add', () => {
			const events: any[] = [];
			workspace.rows.observe((changes) => events.push(...changes));

			workspace.rows.create('posts', 'row1');

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe('add');
			expect(events[0].key).toBe('posts:row1');
		});

		test('cells observer fires on add', () => {
			const events: any[] = [];
			workspace.cells.observe((changes) => events.push(...changes));

			workspace.cells.set('posts', 'row1', 'title', 'Hello');

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe('add');
			expect(events[0].key).toBe('posts:row1:title');
			expect(events[0].value).toBe('Hello');
		});

		test('cells observer fires on update', () => {
			workspace.cells.set('posts', 'row1', 'title', 'Original');

			const events: any[] = [];
			workspace.cells.observe((changes) => events.push(...changes));

			workspace.cells.set('posts', 'row1', 'title', 'Updated');

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe('update');
			expect(events[0].previousValue).toBe('Original');
			expect(events[0].value).toBe('Updated');
		});

		test('kv observer fires on changes', () => {
			const events: any[] = [];
			workspace.kv.observe((changes) => events.push(...changes));

			workspace.kv.set('theme', 'dark');

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe('add');
			expect(events[0].key).toBe('theme');
			expect(events[0].value).toBe('dark');
		});
	});

	describe('batch', () => {
		test('executes multiple operations in sequence', () => {
			// Note: batch wraps operations in a Y.Doc transaction, but each store
			// internally uses transactions that may emit separate updates.
			// The primary benefit is atomicity - if any operation fails, all are rolled back.

			workspace.batch((ws) => {
				ws.rows.create('posts', 'row1');
				ws.cells.set('posts', 'row1', 'title', 'Hello');
				ws.cells.set('posts', 'row1', 'views', 100);
			});

			// Verify all writes completed
			expect(workspace.rows.has('posts', 'row1')).toBe(true);
			expect(workspace.cells.get('posts', 'row1', 'title')).toBe('Hello');
			expect(workspace.cells.get('posts', 'row1', 'views')).toBe(100);
		});
	});
});

describe('type validation', () => {
	test('text type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { text: { name: 'Text', type: 'text', order: 1 } },
		};

		const rowId = ws.rows.create('test');
		ws.cells.set('test', rowId, 'text', 'valid string');

		const rows = ws.getTypedRowsWithCells('test', schema);
		expect(rows[0]!.cells.text!.valid).toBe(true);

		ws.cells.set('test', rowId, 'text', 123);
		const rows2 = ws.getTypedRowsWithCells('test', schema);
		expect(rows2[0]!.cells.text!.valid).toBe(false);
	});

	test('integer type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-int' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { num: { name: 'Num', type: 'integer', order: 1 } },
		};

		const rowId = ws.rows.create('test');

		ws.cells.set('test', rowId, 'num', 42);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.num!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'num', 3.14);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.num!.valid,
		).toBe(false);

		ws.cells.set('test', rowId, 'num', '42');
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.num!.valid,
		).toBe(false);
	});

	test('real type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-real' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { num: { name: 'Num', type: 'real', order: 1 } },
		};

		const rowId = ws.rows.create('test');

		ws.cells.set('test', rowId, 'num', 3.14);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.num!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'num', 42);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.num!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'num', '3.14');
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.num!.valid,
		).toBe(false);
	});

	test('boolean type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-bool' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { flag: { name: 'Flag', type: 'boolean', order: 1 } },
		};

		const rowId = ws.rows.create('test');

		ws.cells.set('test', rowId, 'flag', true);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.flag!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'flag', false);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.flag!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'flag', 1);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.flag!.valid,
		).toBe(false);

		ws.cells.set('test', rowId, 'flag', 'true');
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.flag!.valid,
		).toBe(false);
	});

	test('tags type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-tags' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { tags: { name: 'Tags', type: 'tags', order: 1 } },
		};

		const rowId = ws.rows.create('test');

		ws.cells.set('test', rowId, 'tags', ['a', 'b', 'c']);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.tags!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'tags', []);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.tags!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'tags', [1, 2, 3]);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.tags!.valid,
		).toBe(false);

		ws.cells.set('test', rowId, 'tags', 'not-array');
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.tags!.valid,
		).toBe(false);
	});

	test('date/datetime type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-date' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { date: { name: 'Date', type: 'date', order: 1 } },
		};

		const rowId = ws.rows.create('test');

		ws.cells.set('test', rowId, 'date', '2024-01-15');
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.date!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'date', 1705276800000);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.date!.valid,
		).toBe(true);

		ws.cells.set('test', rowId, 'date', true);
		expect(
			ws.getTypedRowsWithCells('test', schema)[0]!.cells.date!.valid,
		).toBe(false);
	});
});
