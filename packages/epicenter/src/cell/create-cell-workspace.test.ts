import { beforeEach, describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createCellWorkspace } from './create-cell-workspace';
import type {
	CellValue,
	CellWorkspaceClient,
	RowData,
	TableStore,
	WorkspaceDefinition,
} from './types';

/**
 * Helper to extract raw value from validated cell result.
 * Returns undefined if not found, otherwise the raw value.
 */
function getRawValue(store: TableStore, rowId: string, fieldId: string): CellValue | undefined {
	const result = store.get(rowId, fieldId);
	if (result.status === 'not_found') return undefined;
	return result.value;
}

/**
 * Helper to extract raw row data from validated row result.
 * Returns undefined if not found, otherwise the cells record.
 */
function getRawRow(store: TableStore, rowId: string): Record<string, CellValue> | undefined {
	const result = store.getRow(rowId);
	if (result.status === 'not_found') return undefined;
	if (result.status === 'valid') return result.row.cells;
	// For invalid, row contains the cells
	return result.row as Record<string, CellValue>;
}

/**
 * Helper to extract all raw rows from validated results.
 */
function getRawRows(store: TableStore): RowData[] {
	return store.getAll().map((r) =>
		r.status === 'valid' ? r.row : { id: r.id, cells: r.row as Record<string, CellValue> },
	);
}

// Default test definition with posts table
const testDefinition: WorkspaceDefinition = {
	name: 'Test Workspace',
	description: 'A workspace for testing',
	tables: {
		posts: {
			name: 'Blog Posts',
			fields: {
				title: { name: 'Title', type: 'text', order: 1 },
				views: { name: 'Views', type: 'integer', order: 2 },
				published: { name: 'Published', type: 'boolean', order: 3 },
			},
		},
		users: {
			name: 'Users',
			fields: {
				name: { name: 'Name', type: 'text', order: 1 },
			},
		},
	},
	kv: {
		theme: { name: 'Theme', type: 'select', options: ['light', 'dark'] },
		language: { name: 'Language', type: 'text' },
	},
};

describe('createCellWorkspace', () => {
	let workspace: CellWorkspaceClient;
	let posts: TableStore;

	beforeEach(() => {
		workspace = createCellWorkspace({
			id: 'test-workspace',
			definition: testDefinition,
		});
		posts = workspace.table('posts');
	});

	describe('basic functionality', () => {
		test('creates workspace with id and ydoc', () => {
			expect(workspace.id).toBe('test-workspace');
			expect(workspace.ydoc).toBeInstanceOf(Y.Doc);
			expect(workspace.ydoc.guid).toBe('test-workspace');
		});

		test('exposes workspace metadata from definition', () => {
			expect(workspace.name).toBe('Test Workspace');
			expect(workspace.description).toBe('A workspace for testing');
			expect(workspace.icon).toBeNull();
			expect(workspace.definition).toBe(testDefinition);
		});

		test('can use existing ydoc', () => {
			const existingYdoc = new Y.Doc({ guid: 'custom-guid' });
			const ws = createCellWorkspace({
				id: 'test',
				definition: testDefinition,
				ydoc: existingYdoc,
			});
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

		test('can access tables not in definition', () => {
			// Arbitrary table names should work
			const arbitrary = workspace.table('arbitrary');
			expect(arbitrary.tableId).toBe('arbitrary');
		});
	});

	describe('row operations', () => {
		test('creates row with auto-generated id', () => {
			const rowId = posts.createRow();
			expect(rowId).toHaveLength(12);
		});

		test('creates row with custom id', () => {
			const rowId = posts.createRow('custom-id');
			expect(rowId).toBe('custom-id');
		});

		test('hard-deletes row', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			expect(getRawRow(posts, rowId)).toBeDefined();

			posts.deleteRow(rowId);
			expect(getRawRow(posts, rowId)).toBeUndefined();
		});

		test('getAll returns rows sorted by id', () => {
			posts.createRow('row3');
			posts.createRow('row1');
			posts.createRow('row2');
			// Set a cell so each row actually has data
			posts.set('row3', 'title', 'Third');
			posts.set('row1', 'title', 'First');
			posts.set('row2', 'title', 'Second');

			const rows = getRawRows(posts);
			expect(rows.map((r) => r.id)).toEqual(['row1', 'row2', 'row3']);
		});

		test('getRowIds returns all row ids', () => {
			posts.createRow('row1');
			posts.createRow('row2');
			posts.set('row1', 'title', 'First');
			posts.set('row2', 'title', 'Second');

			const ids = posts.getRowIds();
			expect(ids).toContain('row1');
			expect(ids).toContain('row2');
		});

		test('validates tableId does not contain colon', () => {
			expect(() => workspace.table('invalid:table')).toThrow(
				"tableId cannot contain ':' character",
			);
		});

		test('validates rowId does not contain colon', () => {
			expect(() => posts.set('invalid:id', 'title', 'Hello')).toThrow(
				"rowId cannot contain ':' character",
			);
		});
	});

	describe('cell operations', () => {
		test('sets and gets cell value', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello World');
			expect(getRawValue(posts, rowId, 'title')).toBe('Hello World');
		});

		test('get() returns validated result', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello World');
			const result = posts.get(rowId, 'title');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('Hello World');
			}
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

			const row = getRawRow(posts, rowId)!;
			expect(row.title).toBe('Hello');
			expect(row.views).toBe(100);
			expect(row.published).toBe(true);
		});

		test('getRow() returns validated result', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			posts.set(rowId, 'views', 100);

			const result = posts.getRow(rowId);
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.cells.title).toBe('Hello');
				expect(result.row.cells.views).toBe(100);
			}
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

			expect(getRawValue(posts, rowId, 'text')).toBe('hello');
			expect(getRawValue(posts, rowId, 'number')).toBe(42);
			expect(getRawValue(posts, rowId, 'float')).toBe(3.14);
			expect(getRawValue(posts, rowId, 'bool')).toBe(true);
			expect(getRawValue(posts, rowId, 'array')).toEqual(['a', 'b']);
			expect(getRawValue(posts, rowId, 'object')).toEqual({ nested: 'value' });
			expect(getRawValue(posts, rowId, 'null')).toBeNull();
		});

		test('validates fieldId does not contain colon', () => {
			const rowId = posts.createRow();
			expect(() => posts.set(rowId, 'invalid:field', 'value')).toThrow(
				"fieldId cannot contain ':' character",
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

	describe('getTypedRows', () => {
		test('validates cell types against schema', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			posts.set(rowId, 'views', 100);
			posts.set(rowId, 'published', true);

			const rows = workspace.getTypedRows('posts');
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

			const rows = workspace.getTypedRows('posts');
			const row = rows[0]!;

			expect(row.cells.title!.valid).toBe(false);
			expect(row.cells.views!.valid).toBe(false);
			expect(row.cells.published!.valid).toBe(false);
		});

		test('identifies missing fields', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello');
			// views and published are missing

			const rows = workspace.getTypedRows('posts');
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

			const rows = workspace.getTypedRows('posts');
			const row = rows[0]!;

			expect(row.extraFields).toContain('unknownField');
			expect(row.extraFields).toContain('anotherExtra');
			expect(row.extraFields).not.toContain('title');
		});

		test('handles null/undefined values as valid', () => {
			const rowId = posts.createRow();
			posts.set(rowId, 'title', null);

			const rows = workspace.getTypedRows('posts');
			const row = rows[0]!;

			expect(row.cells.title!.valid).toBe(true);
			expect(row.cells.title!.value).toBeNull();
		});

		test('handles tables not in definition gracefully', () => {
			const arbitrary = workspace.table('notInSchema');
			arbitrary.set('row1', 'field1', 'value1');

			const rows = workspace.getTypedRows('notInSchema');
			expect(rows).toHaveLength(1);
			expect(rows[0]!.cells.field1).toEqual({
				value: 'value1',
				type: 'json',
				valid: true,
			});
			expect(rows[0]!.extraFields).toContain('field1');
		});
	});

	describe('CRDT sync behavior', () => {
		test('syncs between two workspaces', () => {
			const ws1 = createCellWorkspace({
				id: 'sync-test',
				definition: testDefinition,
			});
			const ws2 = createCellWorkspace({
				id: 'sync-test',
				definition: testDefinition,
			});

			// Create row in ws1
			const posts1 = ws1.table('posts');
			const rowId = posts1.createRow('row1');
			posts1.set(rowId, 'title', 'Hello from WS1');

			// Sync ws1 -> ws2
			const update1 = Y.encodeStateAsUpdate(ws1.ydoc);
			Y.applyUpdate(ws2.ydoc, update1);

			// Verify ws2 has the data
			const posts2 = ws2.table('posts');
			expect(getRawRow(posts2, 'row1')).toBeDefined();
			expect(getRawValue(posts2, 'row1', 'title')).toBe('Hello from WS1');

			// Make change in ws2
			posts2.set(rowId, 'title', 'Updated in WS2');

			// Sync ws2 -> ws1
			const update2 = Y.encodeStateAsUpdate(ws2.ydoc);
			Y.applyUpdate(ws1.ydoc, update2);

			// Verify ws1 has the update
			expect(getRawValue(posts1, 'row1', 'title')).toBe('Updated in WS2');
		});

		test('last-write-wins for concurrent cell edits', async () => {
			const ws1 = createCellWorkspace({
				id: 'lww-test',
				definition: testDefinition,
			});
			const ws2 = createCellWorkspace({
				id: 'lww-test',
				definition: testDefinition,
			});

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
			expect(getRawValue(posts1, 'row1', 'title')).toBe('From WS1');
			expect(getRawValue(posts1, 'row1', 'views')).toBe(999);
			expect(getRawValue(posts2, 'row1', 'title')).toBe('From WS1');
			expect(getRawValue(posts2, 'row1', 'views')).toBe(999);
		});

		test('same cell concurrent edit - later timestamp wins', async () => {
			const ws1 = createCellWorkspace({
				id: 'lww-same-cell',
				definition: testDefinition,
			});
			const ws2 = createCellWorkspace({
				id: 'lww-same-cell',
				definition: testDefinition,
			});

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
			expect(getRawValue(posts1, 'row1', 'title')).toBe('From WS2 (later)');
			expect(getRawValue(posts2, 'row1', 'title')).toBe('From WS2 (later)');
		});
	});

	describe('observers', () => {
		test('observe fires on cell add', () => {
			const events: any[] = [];
			posts.observe((changes) => events.push(...changes));

			const rowId = posts.createRow('row1');
			posts.set(rowId, 'title', 'Hello');

			expect(events).toHaveLength(1);
			expect(events[0].type).toBe('add');
			expect(events[0].key).toBe('row1:title');
			expect(events[0].value).toBe('Hello');
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
			expect(getRawRow(posts, 'row1')).toBeDefined();
			expect(getRawValue(posts, 'row1', 'title')).toBe('Hello');
			expect(getRawValue(posts, 'row1', 'views')).toBe(100);
		});
	});

	describe('consolidated validation API', () => {
		test('table has schema property', () => {
			expect(posts.schema).toBeDefined();
			expect(posts.schema.name).toBe('Blog Posts');
		});

		test('dynamic table has empty schema', () => {
			const dynamicTable = workspace.table('dynamic');
			expect(dynamicTable.schema.name).toBe('dynamic');
			expect(dynamicTable.schema.fields).toEqual({});
		});

		test('getAll returns validated results', () => {
			posts.set('row1', 'title', 'Valid');
			posts.set('row1', 'views', 100);

			posts.set('row2', 'title', 123); // Invalid - should be text
			posts.set('row2', 'views', 'invalid'); // Invalid - should be integer

			const results = posts.getAll();
			expect(results.length).toBe(2);

			const valid = results.filter((r) => r.status === 'valid');
			const invalid = results.filter((r) => r.status === 'invalid');
			expect(valid.length).toBe(1);
			expect(invalid.length).toBe(1);
		});

		test('getAllValid filters out invalid rows', () => {
			posts.set('row1', 'title', 'Valid');
			posts.set('row2', 'title', 123); // Invalid

			const validRows = posts.getAllValid();
			expect(validRows.length).toBe(1);
			expect(validRows[0]?.cells.title).toBe('Valid');
		});

		test('getAllInvalid returns only invalid rows', () => {
			posts.set('row1', 'title', 'Valid');
			posts.set('row2', 'views', 'not a number'); // Invalid

			const invalidRows = posts.getAllInvalid();
			expect(invalidRows.length).toBe(1);
			expect(invalidRows[0]?.id).toBe('row2');
			expect(invalidRows[0]?.errors.length).toBeGreaterThan(0);
		});

		test('dynamic tables pass all validation (no schema)', () => {
			const dynamicTable = workspace.table('dynamic');
			dynamicTable.set('row1', 'anything', { any: 'value' });
			dynamicTable.set('row2', 'field', 12345);

			const all = dynamicTable.getAll();
			expect(all.every((r) => r.status === 'valid')).toBe(true);

			const invalid = dynamicTable.getAllInvalid();
			expect(invalid.length).toBe(0);
		});
	});
});

describe('type validation', () => {
	const makeDefinition = (
		fieldName: string,
		fieldType: string,
	): WorkspaceDefinition => ({
		name: 'Test',
		tables: {
			test: {
				name: 'Test',
				fields: {
					[fieldName]: { name: fieldName, type: fieldType as any, order: 1 },
				},
			},
		},
	});

	test('text type validation', () => {
		const ws = createCellWorkspace({
			id: 'type-test',
			definition: makeDefinition('text', 'text'),
		});

		const t = ws.table('test');
		const rowId = t.createRow();
		t.set(rowId, 'text', 'valid string');

		const rows = ws.getTypedRows('test');
		expect(rows[0]!.cells.text!.valid).toBe(true);

		t.set(rowId, 'text', 123);
		const rows2 = ws.getTypedRows('test');
		expect(rows2[0]!.cells.text!.valid).toBe(false);
	});

	test('integer type validation', () => {
		const ws = createCellWorkspace({
			id: 'type-test-int',
			definition: makeDefinition('num', 'integer'),
		});

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'num', 42);
		expect(ws.getTypedRows('test')[0]!.cells.num!.valid).toBe(true);

		t.set(rowId, 'num', 3.14);
		expect(ws.getTypedRows('test')[0]!.cells.num!.valid).toBe(false);

		t.set(rowId, 'num', '42');
		expect(ws.getTypedRows('test')[0]!.cells.num!.valid).toBe(false);
	});

	test('real type validation', () => {
		const ws = createCellWorkspace({
			id: 'type-test-real',
			definition: makeDefinition('num', 'real'),
		});

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'num', 3.14);
		expect(ws.getTypedRows('test')[0]!.cells.num!.valid).toBe(true);

		t.set(rowId, 'num', 42);
		expect(ws.getTypedRows('test')[0]!.cells.num!.valid).toBe(true);

		t.set(rowId, 'num', '3.14');
		expect(ws.getTypedRows('test')[0]!.cells.num!.valid).toBe(false);
	});

	test('boolean type validation', () => {
		const ws = createCellWorkspace({
			id: 'type-test-bool',
			definition: makeDefinition('flag', 'boolean'),
		});

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'flag', true);
		expect(ws.getTypedRows('test')[0]!.cells.flag!.valid).toBe(true);

		t.set(rowId, 'flag', false);
		expect(ws.getTypedRows('test')[0]!.cells.flag!.valid).toBe(true);

		t.set(rowId, 'flag', 1);
		expect(ws.getTypedRows('test')[0]!.cells.flag!.valid).toBe(false);

		t.set(rowId, 'flag', 'true');
		expect(ws.getTypedRows('test')[0]!.cells.flag!.valid).toBe(false);
	});

	test('tags type validation', () => {
		const ws = createCellWorkspace({
			id: 'type-test-tags',
			definition: makeDefinition('tags', 'tags'),
		});

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'tags', ['a', 'b', 'c']);
		expect(ws.getTypedRows('test')[0]!.cells.tags!.valid).toBe(true);

		t.set(rowId, 'tags', []);
		expect(ws.getTypedRows('test')[0]!.cells.tags!.valid).toBe(true);

		t.set(rowId, 'tags', [1, 2, 3]);
		expect(ws.getTypedRows('test')[0]!.cells.tags!.valid).toBe(false);

		t.set(rowId, 'tags', 'not-array');
		expect(ws.getTypedRows('test')[0]!.cells.tags!.valid).toBe(false);
	});

	test('date/datetime type validation', () => {
		const ws = createCellWorkspace({
			id: 'type-test-date',
			definition: makeDefinition('date', 'date'),
		});

		const t = ws.table('test');
		const rowId = t.createRow();

		t.set(rowId, 'date', '2024-01-15');
		expect(ws.getTypedRows('test')[0]!.cells.date!.valid).toBe(true);

		t.set(rowId, 'date', 1705276800000);
		expect(ws.getTypedRows('test')[0]!.cells.date!.valid).toBe(true);

		t.set(rowId, 'date', true);
		expect(ws.getTypedRows('test')[0]!.cells.date!.valid).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// HeadDoc-based API tests (new)
// ════════════════════════════════════════════════════════════════════════════

import { defineExports } from '../core/lifecycle';

describe('createCellWorkspace with HeadDoc', () => {
	// Minimal HeadDoc mock for testing
	const createMockHeadDoc = (workspaceId: string, epoch = 0) => ({
		workspaceId,
		getEpoch: () => epoch,
	});

	const testDefinition = {
		name: 'Test Workspace',
		tables: {
			posts: {
				name: 'Posts',
				fields: {
					title: { name: 'Title', type: 'text' as const, order: 1 },
					views: { name: 'Views', type: 'integer' as const, order: 2 },
				},
			},
			users: {
				name: 'Users',
				fields: {
					name: { name: 'Name', type: 'text' as const, order: 1 },
				},
			},
		},
	} as const;

	describe('builder pattern', () => {
		test('returns builder with withExtensions method', () => {
			const headDoc = createMockHeadDoc('test-workspace');
			const builder = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			});

			expect(typeof builder.withExtensions).toBe('function');
		});

		test('withExtensions creates workspace client', () => {
			const headDoc = createMockHeadDoc('test-workspace');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			expect(workspace.id).toBe('test-workspace');
			expect(workspace.epoch).toBe(0);
			expect(workspace.ydoc).toBeInstanceOf(Y.Doc);
		});
	});

	describe('epoch-based doc ID', () => {
		test('Y.Doc guid is workspaceId-epoch at epoch 0', () => {
			const headDoc = createMockHeadDoc('my-workspace', 0);
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			expect(workspace.ydoc.guid).toBe('my-workspace-0');
		});

		test('Y.Doc guid is workspaceId-epoch at epoch 1', () => {
			const headDoc = createMockHeadDoc('my-workspace', 1);
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			expect(workspace.ydoc.guid).toBe('my-workspace-1');
		});

		test('Y.Doc guid is workspaceId-epoch at epoch 42', () => {
			const headDoc = createMockHeadDoc('my-workspace', 42);
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			expect(workspace.ydoc.guid).toBe('my-workspace-42');
		});

		test('epoch is exposed on workspace client', () => {
			const headDoc = createMockHeadDoc('my-workspace', 5);
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			expect(workspace.epoch).toBe(5);
		});
	});

	describe('extension system', () => {
		test('extensions are initialized and accessible', () => {
			const headDoc = createMockHeadDoc('test-workspace');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				mock: () =>
					defineExports({
						customValue: 'hello',
					}),
			});

			expect(workspace.extensions.mock.customValue).toBe('hello');
		});

		test('extension receives correct context', () => {
			const headDoc = createMockHeadDoc('ctx-test', 3);
			let receivedContext: any = null;

			createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				inspector: (ctx) => {
					receivedContext = ctx;
					return defineExports({});
				},
			});

			expect(receivedContext.workspaceId).toBe('ctx-test');
			expect(receivedContext.epoch).toBe(3);
			expect(receivedContext.extensionId).toBe('inspector');
			expect(receivedContext.ydoc).toBeInstanceOf(Y.Doc);
			expect(typeof receivedContext.table).toBe('function');
			expect(typeof receivedContext.kv.get).toBe('function');
		});

		test('extension can access tables from context', () => {
			const headDoc = createMockHeadDoc('table-ctx-test');
			let tablePosts: any = null;

			createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				inspector: (ctx) => {
					tablePosts = ctx.table('posts');
					return defineExports({});
				},
			});

			expect(tablePosts).not.toBeNull();
			expect(tablePosts.tableId).toBe('posts');
		});

		test('multiple extensions are all initialized', () => {
			const headDoc = createMockHeadDoc('multi-ext-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				ext1: () => defineExports({ value: 1 }),
				ext2: () => defineExports({ value: 2 }),
				ext3: () => defineExports({ value: 3 }),
			});

			expect(workspace.extensions.ext1.value).toBe(1);
			expect(workspace.extensions.ext2.value).toBe(2);
			expect(workspace.extensions.ext3.value).toBe(3);
		});

		test('extensions have normalized lifecycle', () => {
			const headDoc = createMockHeadDoc('lifecycle-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				minimal: () => defineExports({}),
			});

			// defineExports should have added whenSynced and destroy
			expect(workspace.extensions.minimal.whenSynced).toBeInstanceOf(Promise);
			expect(typeof workspace.extensions.minimal.destroy).toBe('function');
		});
	});

	describe('workspace lifecycle', () => {
		test('whenSynced resolves when all extensions sync', async () => {
			let syncResolve: () => void;
			const syncPromise = new Promise<void>((resolve) => {
				syncResolve = resolve;
			});

			const headDoc = createMockHeadDoc('sync-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				async: () =>
					defineExports({
						whenSynced: syncPromise,
					}),
			});

			let synced = false;
			workspace.whenSynced.then(() => {
				synced = true;
			});

			expect(synced).toBe(false);
			syncResolve!();
			await workspace.whenSynced;
			expect(synced).toBe(true);
		});

		test('destroy calls all extension destroys', async () => {
			const destroyed: string[] = [];
			const headDoc = createMockHeadDoc('destroy-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({
				ext1: () =>
					defineExports({
						destroy: () => {
							destroyed.push('ext1');
						},
					}),
				ext2: () =>
					defineExports({
						destroy: () => {
							destroyed.push('ext2');
						},
					}),
			});

			await workspace.destroy();
			expect(destroyed).toContain('ext1');
			expect(destroyed).toContain('ext2');
		});

		test('destroy destroys Y.Doc', async () => {
			const headDoc = createMockHeadDoc('ydoc-destroy-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			const ydoc = workspace.ydoc;
			expect(ydoc.isDestroyed).toBe(false);
			await workspace.destroy();
			expect(ydoc.isDestroyed).toBe(true);
		});
	});

	describe('workspace functionality', () => {
		test('can create and read rows', () => {
			const headDoc = createMockHeadDoc('row-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			const posts = workspace.table('posts');
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Hello World');
			posts.set(rowId, 'views', 100);

			const row = getRawRow(posts, rowId);
			expect(row?.title).toBe('Hello World');
			expect(row?.views).toBe(100);
		});

		test('kv store works', () => {
			const headDoc = createMockHeadDoc('kv-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			workspace.kv.set('theme', 'dark');
			expect(workspace.kv.get('theme')).toBe('dark');
		});

		test('batch operations work', () => {
			const headDoc = createMockHeadDoc('batch-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			workspace.batch((ws) => {
				const posts = ws.table('posts');
				const row1 = posts.createRow();
				const row2 = posts.createRow();
				posts.set(row1, 'title', 'Post 1');
				posts.set(row2, 'title', 'Post 2');
			});

			const rows = getRawRows(workspace.table('posts'));
			expect(rows.length).toBe(2);
		});

		test('getTypedRows works with HeadDoc API', () => {
			const headDoc = createMockHeadDoc('typed-rows-test');
			const workspace = createCellWorkspace({
				headDoc,
				definition: testDefinition,
			}).withExtensions({});

			const posts = workspace.table('posts');
			const rowId = posts.createRow();
			posts.set(rowId, 'title', 'Test Post');
			posts.set(rowId, 'views', 42);

			const typedRows = workspace.getTypedRows('posts');
			expect(typedRows.length).toBe(1);
			expect(typedRows[0]!.cells.title!.value).toBe('Test Post');
			expect(typedRows[0]!.cells.title!.type).toBe('text');
			expect(typedRows[0]!.cells.views!.value).toBe(42);
			expect(typedRows[0]!.cells.views!.type).toBe('integer');
		});
	});

	describe('legacy API compatibility', () => {
		test('legacy API still works', () => {
			const workspace = createCellWorkspace({
				id: 'legacy-test',
				definition: {
					name: 'Legacy Workspace',
					tables: {
						items: {
							name: 'Items',
							fields: {
								name: { name: 'Name', type: 'text', order: 1 },
							},
						},
					},
				},
			});

			expect(workspace.id).toBe('legacy-test');
			expect(workspace.epoch).toBe(0);
			expect(workspace.ydoc.guid).toBe('legacy-test');
			expect(workspace.extensions).toEqual({});
		});

		test('legacy API has whenSynced that resolves immediately', async () => {
			const workspace = createCellWorkspace({
				id: 'legacy-sync-test',
				definition: { name: 'Test', tables: {} },
			});

			// Should resolve immediately
			await workspace.whenSynced;
		});
	});
});
