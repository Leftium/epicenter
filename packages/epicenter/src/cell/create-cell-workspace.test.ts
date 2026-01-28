import { describe, test, expect, beforeEach } from 'bun:test';
import * as Y from 'yjs';
import { createCellWorkspace } from './create-cell-workspace';
import type { CellWorkspaceClient, SchemaTableDefinition, TableStore } from './types';

describe('createCellWorkspace', () => {
	let workspace: CellWorkspaceClient;
	let posts: TableStore;

	beforeEach(() => {
		workspace = createCellWorkspace({ id: 'test-workspace' });
		posts = workspace.table('posts');
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

		test('table() returns cached instance', () => {
			const posts1 = workspace.table('posts');
			const posts2 = workspace.table('posts');
			expect(posts1).toBe(posts2);
		});

		test('different tables return different stores', () => {
			const users = workspace.table('users');
			expect(posts).not.toBe(users);
			expect(posts.tableId).toBe('posts');
			expect(users.tableId).toBe('users');
		});
	});

	describe('row operations', () => {
		test('creates row with auto-generated id', () => {
			const rowId = posts.createRow();
			expect(rowId).toHaveLength(12);
			expect(posts.getRow(rowId)).toBeDefined();
		});

		test('creates row with custom id', () => {
			const rowId = posts.createRow('custom-id');
			expect(rowId).toBe('custom-id');
			expect(posts.getRow('custom-id')).toBeDefined();
		});

		test('auto-assigns order', () => {
			const row1 = posts.createRow('row1');
			const row2 = posts.createRow('row2');
			const row3 = posts.createRow('row3');

			expect(posts.get(row1, '_order')).toBe(1);
			expect(posts.get(row2, '_order')).toBe(2);
			expect(posts.get(row3, '_order')).toBe(3);
		});

		test('creates row with custom order', () => {
			const rowId = posts.createRow('row1', 100);
			expect(posts.get(rowId, '_order')).toBe(100);
		});

		test('soft-deletes row', () => {
			const rowId = posts.createRow();
			posts.deleteRow(rowId);

			const deletedAt = posts.get(rowId, '_deletedAt');
			expect(deletedAt).not.toBeNull();
			expect(typeof deletedAt).toBe('number');
		});

		test('restores soft-deleted row', () => {
			const rowId = posts.createRow();
			posts.deleteRow(rowId);
			posts.restoreRow(rowId);

			expect(posts.get(rowId, '_deletedAt')).toBeNull();
		});

		test('getRows returns active rows sorted by order', () => {
			posts.createRow('row3', 3);
			posts.createRow('row1', 1);
			posts.createRow('row2', 2);

			const rows = posts.getRows();
			expect(rows.map((r) => r.id)).toEqual(['row1', 'row2', 'row3']);
		});

		test('getRows excludes soft-deleted rows', () => {
			posts.createRow('row1');
			posts.createRow('row2');
			posts.deleteRow('row1');

			const rows = posts.getRows();
			expect(rows.map((r) => r.id)).toEqual(['row2']);
		});

		test('getAllRows includes soft-deleted rows', () => {
			posts.createRow('row1');
			posts.createRow('row2');
			posts.deleteRow('row1');

			const rows = posts.getAllRows();
			expect(rows.map((r) => r.id)).toContain('row1');
			expect(rows.map((r) => r.id)).toContain('row2');
		});

		test('reorders row', () => {
			const rowId = posts.createRow('row1', 1);
			posts.reorderRow(rowId, 100);
			expect(posts.get(rowId, '_order')).toBe(100);
		});

		test('validates tableId does not contain colon', () => {
			expect(() => workspace.table('invalid:table')).toThrow(
				"tableId cannot contain ':' character",
			);
		});

		test('validates rowId does not contain colon', () => {
			expect(() => posts.createRow('invalid:id')).toThrow(
				"rowId cannot contain ':' character",
			);
		});
	});

	describe('cell operations', () => {
		test('sets and gets cell value', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello World');
			expect(posts.get(rowId, 'title')).toBe('Hello World');
		});

		test('deletes cell value', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			posts.delete(rowId, 'title');
			expect(posts.has(rowId, 'title')).toBe(false);
		});

		test('getRow returns all cells for a row', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			posts.set(rowId, 'views', 100);
			posts.set(rowId, 'published', true);

			const row = posts.getRow(rowId)!;
			expect(row.title).toBe('Hello');
			expect(row.views).toBe(100);
			expect(row.published).toBe(true);
			// Also includes metadata
			expect(row._order).toBe(1);
			expect(row._deletedAt).toBeNull();
		});

		test('stores various data types', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'text', 'hello');
			posts.set(rowId, 'number', 42);
			posts.set(rowId, 'float', 3.14);
			posts.set(rowId, 'bool', true);
			posts.set(rowId, 'array', ['a', 'b']);
			posts.set(rowId, 'object', { nested: 'value' });
			posts.set(rowId, 'null', null);

			expect(posts.get(rowId, 'text')).toBe('hello');
			expect(posts.get(rowId, 'number')).toBe(42);
			expect(posts.get(rowId, 'float')).toBe(3.14);
			expect(posts.get(rowId, 'bool')).toBe(true);
			expect(posts.get(rowId, 'array')).toEqual(['a', 'b']);
			expect(posts.get(rowId, 'object')).toEqual({ nested: 'value' });
			expect(posts.get(rowId, 'null')).toBeNull();
		});

		test('validates fieldId does not contain colon', () => {
			const rowId = posts.createRow();
			expect(() => posts.set(rowId, 'invalid:field', 'value')).toThrow(
				"fieldId cannot contain ':' character",
			);
		});

		test('validates fieldId is not reserved', () => {
			const rowId = posts.createRow();
			expect(() => posts.set(rowId, '_order', 999)).toThrow(
				'fieldId "_order" is reserved',
			);
			expect(() => posts.set(rowId, '_deletedAt', null)).toThrow(
				'fieldId "_deletedAt" is reserved',
			);
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

	describe('getRowsWithoutMeta', () => {
		test('returns rows with cells separated from metadata', () => {
			const row1 = posts.createRow();
			const row2 = posts.createRow();

			posts.set(row1, 'title', 'First Post');
			posts.set(row1, 'views', 100);
			posts.set(row2, 'title', 'Second Post');

			const rows = posts.getRowsWithoutMeta();

			expect(rows).toHaveLength(2);
			expect(rows[0]!.id).toBe(row1);
			expect(rows[0]!.order).toBe(1);
			expect(rows[0]!.deletedAt).toBeNull();
			expect(rows[0]!.cells).toEqual({ title: 'First Post', views: 100 });
			expect(rows[1]!.id).toBe(row2);
			expect(rows[1]!.cells).toEqual({ title: 'Second Post' });
		});

		test('excludes soft-deleted rows', () => {
			const row1 = posts.createRow();
			const row2 = posts.createRow();
			posts.set(row1, 'title', 'First');
			posts.set(row2, 'title', 'Second');

			posts.deleteRow(row1);

			const rows = posts.getRowsWithoutMeta();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.cells.title).toBe('Second');
		});
	});

	describe('getTypedRows', () => {
		const postsSchema: SchemaTableDefinition = {
			name: 'Blog Posts',
			fields: {
				title: { name: 'Title', type: 'text', order: 1 },
				views: { name: 'Views', type: 'integer', order: 2 },
				published: { name: 'Published', type: 'boolean', order: 3 },
			},
		};

		test('validates cell types against schema', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			posts.set(rowId, 'views', 100);
			posts.set(rowId, 'published', true);

			const rows = workspace.getTypedRows('posts', postsSchema);
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
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 123); // Should be text
			posts.set(rowId, 'views', 'not a number'); // Should be integer
			posts.set(rowId, 'published', 'yes'); // Should be boolean

			const rows = workspace.getTypedRows('posts', postsSchema);
			const row = rows[0]!;

			expect(row.cells.title!.valid).toBe(false);
			expect(row.cells.views!.valid).toBe(false);
			expect(row.cells.published!.valid).toBe(false);
		});

		test('identifies missing fields', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			// views and published are missing

			const rows = workspace.getTypedRows('posts', postsSchema);
			const row = rows[0]!;

			expect(row.missingFields).toContain('views');
			expect(row.missingFields).toContain('published');
			expect(row.missingFields).not.toContain('title');
		});

		test('identifies extra fields not in schema', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			posts.set(rowId, 'unknownField', 'value');
			posts.set(rowId, 'anotherExtra', 42);

			const rows = workspace.getTypedRows('posts', postsSchema);
			const row = rows[0]!;

			expect(row.extraFields).toContain('unknownField');
			expect(row.extraFields).toContain('anotherExtra');
			expect(row.extraFields).not.toContain('title');
		});

		test('handles null/undefined values as valid', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', null);

			const rows = workspace.getTypedRows('posts', postsSchema);
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
			const posts1 = ws1.table('posts');
			const rowId = posts1.createRow('row1');
			posts1.set(rowId, 'title', 'Hello from WS1');

			// Sync ws1 -> ws2
			const update1 = Y.encodeStateAsUpdate(ws1.ydoc);
			Y.applyUpdate(ws2.ydoc, update1);

			// Verify ws2 has the data
			const posts2 = ws2.table('posts');
			expect(posts2.getRow('row1')).toBeDefined();
			expect(posts2.get('row1', 'title')).toBe('Hello from WS1');

			// Make change in ws2
			posts2.set(rowId, 'title', 'Updated in WS2');

			// Sync ws2 -> ws1
			const update2 = Y.encodeStateAsUpdate(ws2.ydoc);
			Y.applyUpdate(ws1.ydoc, update2);

			// Verify ws1 has the update
			expect(posts1.get('row1', 'title')).toBe('Updated in WS2');
		});

		test('last-write-wins for concurrent cell edits', async () => {
			const ws1 = createCellWorkspace({ id: 'lww-test' });
			const ws2 = createCellWorkspace({ id: 'lww-test' });

			// WS1 creates the row first
			const posts1 = ws1.table('posts');
			posts1.createRow('row1');
			posts1.set('row1', 'title', 'Initial');

			// Sync ws1 -> ws2 so both share the same underlying Y.Array
			Y.applyUpdate(ws2.ydoc, Y.encodeStateAsUpdate(ws1.ydoc));

			// Now both can make concurrent edits to different cells
			const posts2 = ws2.table('posts');
			posts1.set('row1', 'title', 'From WS1');
			posts2.set('row1', 'views', 999);

			// Sync both ways
			const update1 = Y.encodeStateAsUpdate(ws1.ydoc);
			const update2 = Y.encodeStateAsUpdate(ws2.ydoc);
			Y.applyUpdate(ws2.ydoc, update1);
			Y.applyUpdate(ws1.ydoc, update2);

			// Both should have BOTH edits (different cells, both win)
			expect(posts1.get('row1', 'title')).toBe('From WS1');
			expect(posts1.get('row1', 'views')).toBe(999);
			expect(posts2.get('row1', 'title')).toBe('From WS1');
			expect(posts2.get('row1', 'views')).toBe(999);
		});

		test('same cell concurrent edit - later timestamp wins', async () => {
			const ws1 = createCellWorkspace({ id: 'lww-same-cell' });
			const ws2 = createCellWorkspace({ id: 'lww-same-cell' });

			// WS1 creates the row first
			const posts1 = ws1.table('posts');
			posts1.createRow('row1');

			// Sync so both share the Y.Array
			Y.applyUpdate(ws2.ydoc, Y.encodeStateAsUpdate(ws1.ydoc));

			// Both edit the same cell
			posts1.set('row1', 'title', 'From WS1');
			await new Promise((resolve) => setTimeout(resolve, 2));
			const posts2 = ws2.table('posts');
			posts2.set('row1', 'title', 'From WS2 (later)');

			// Sync both ways
			const update1 = Y.encodeStateAsUpdate(ws1.ydoc);
			const update2 = Y.encodeStateAsUpdate(ws2.ydoc);
			Y.applyUpdate(ws2.ydoc, update1);
			Y.applyUpdate(ws1.ydoc, update2);

			// Both should have the later value (WS2)
			expect(posts1.get('row1', 'title')).toBe('From WS2 (later)');
			expect(posts2.get('row1', 'title')).toBe('From WS2 (later)');
		});
	});

	describe('observers', () => {
		test('observe fires on cell add', () => {
			const events: any[] = [];
			posts.observe((changes) => events.push(...changes));

			posts.createRow('row1');

			// Should have events for _order and _deletedAt
			expect(events.length).toBeGreaterThanOrEqual(2);
			const keys = events.map((e) => e.key);
			expect(keys).toContain('row1:_order');
			expect(keys).toContain('row1:_deletedAt');
		});

		test('observe fires on user cell changes', () => {
			const rowId = posts.createRow();
			const events: any[] = [];
			posts.observe((changes) => events.push(...changes));

			posts.set(rowId, 'title', 'Hello');

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe('add');
			expect(events[0].key).toBe(`${rowId}:title`);
			expect(events[0].value).toBe('Hello');
		});

		test('observe fires on cell update', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Original');

			const events: any[] = [];
			posts.observe((changes) => events.push(...changes));

			posts.set(rowId, 'title', 'Updated');

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
		test('executes multiple operations', () => {
			workspace.batch((ws) => {
				const p = ws.table('posts');
				p.createRow('row1');
				p.set('row1', 'title', 'Hello');
				p.set('row1', 'views', 100);
			});

			// Verify all writes completed
			expect(posts.getRow('row1')).toBeDefined();
			expect(posts.get('row1', 'title')).toBe('Hello');
			expect(posts.get('row1', 'views')).toBe(100);
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

		const t = ws.table('test');
		const rowId = t.createRow();
		t.set(rowId, 'text', 'valid string');

		const rows = ws.getTypedRows('test', schema);
		expect(rows[0]!.cells.text!.valid).toBe(true);

		t.set(rowId, 'text', 123);
		const rows2 = ws.getTypedRows('test', schema);
		expect(rows2[0]!.cells.text!.valid).toBe(false);
	});

	test('integer type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-int' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { num: { name: 'Num', type: 'integer', order: 1 } },
		};

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'num', 42);
		expect(ws.getTypedRows('test', schema)[0]!.cells.num!.valid).toBe(true);

		t.set(rowId, 'num', 3.14);
		expect(ws.getTypedRows('test', schema)[0]!.cells.num!.valid).toBe(false);

		t.set(rowId, 'num', '42');
		expect(ws.getTypedRows('test', schema)[0]!.cells.num!.valid).toBe(false);
	});

	test('real type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-real' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { num: { name: 'Num', type: 'real', order: 1 } },
		};

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'num', 3.14);
		expect(ws.getTypedRows('test', schema)[0]!.cells.num!.valid).toBe(true);

		t.set(rowId, 'num', 42);
		expect(ws.getTypedRows('test', schema)[0]!.cells.num!.valid).toBe(true);

		t.set(rowId, 'num', '3.14');
		expect(ws.getTypedRows('test', schema)[0]!.cells.num!.valid).toBe(false);
	});

	test('boolean type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-bool' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { flag: { name: 'Flag', type: 'boolean', order: 1 } },
		};

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'flag', true);
		expect(ws.getTypedRows('test', schema)[0]!.cells.flag!.valid).toBe(true);

		t.set(rowId, 'flag', false);
		expect(ws.getTypedRows('test', schema)[0]!.cells.flag!.valid).toBe(true);

		t.set(rowId, 'flag', 1);
		expect(ws.getTypedRows('test', schema)[0]!.cells.flag!.valid).toBe(false);

		t.set(rowId, 'flag', 'true');
		expect(ws.getTypedRows('test', schema)[0]!.cells.flag!.valid).toBe(false);
	});

	test('tags type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-tags' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { tags: { name: 'Tags', type: 'tags', order: 1 } },
		};

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'tags', ['a', 'b', 'c']);
		expect(ws.getTypedRows('test', schema)[0]!.cells.tags!.valid).toBe(true);

		t.set(rowId, 'tags', []);
		expect(ws.getTypedRows('test', schema)[0]!.cells.tags!.valid).toBe(true);

		t.set(rowId, 'tags', [1, 2, 3]);
		expect(ws.getTypedRows('test', schema)[0]!.cells.tags!.valid).toBe(false);

		t.set(rowId, 'tags', 'not-array');
		expect(ws.getTypedRows('test', schema)[0]!.cells.tags!.valid).toBe(false);
	});

	test('date/datetime type validation', () => {
		const ws = createCellWorkspace({ id: 'type-test-date' });
		const schema: SchemaTableDefinition = {
			name: 'Test',
			fields: { date: { name: 'Date', type: 'date', order: 1 } },
		};

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'date', '2024-01-15');
		expect(ws.getTypedRows('test', schema)[0]!.cells.date!.valid).toBe(true);

		t.set(rowId, 'date', 1705276800000);
		expect(ws.getTypedRows('test', schema)[0]!.cells.date!.valid).toBe(true);

		t.set(rowId, 'date', true);
		expect(ws.getTypedRows('test', schema)[0]!.cells.date!.valid).toBe(false);
	});
});
