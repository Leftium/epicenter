import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../core/utils/y-keyvalue-lww';
import { createTableStore } from './table-store';
import type { CellValue, SchemaTableDefinition } from './types';

function createTestStore(tableId: string, schema: SchemaTableDefinition = { name: tableId, fields: {} }) {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<YKeyValueLwwEntry<CellValue>>(tableId);
	return { ydoc, tableStore: createTableStore(tableId, yarray, schema) };
}

const postsSchema: SchemaTableDefinition = {
	name: 'Posts',
	fields: {
		title: { name: 'Title', type: 'text', order: 1 },
		views: { name: 'Views', type: 'integer', order: 2 },
		status: {
			name: 'Status',
			type: 'select',
			order: 3,
			options: ['draft', 'published'],
		},
	},
};

describe('TableStore with schema (consolidated API)', () => {
	describe('get (validated)', () => {
		test('returns valid for correct cell value', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'title', 'Hello World');

			const result = tableStore.get(rowId, 'title');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('Hello World');
			}
		});

		test('returns valid for null value (all fields nullable)', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'views', null);

			const result = tableStore.get(rowId, 'views');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(null);
			}
		});

		test('returns invalid for wrong type', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'views', 'not a number');

			const result = tableStore.get(rowId, 'views');
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.value).toBe('not a number');
			}
		});

		test('returns not_found for missing cell', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const result = tableStore.get('nonexistent-row', 'title');
			expect(result.status).toBe('not_found');
			if (result.status === 'not_found') {
				expect(result.key).toBe('nonexistent-row:title');
			}
		});

		test('fields not in schema pass validation (advisory behavior)', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'extra_field', { any: 'value' });

			const result = tableStore.get(rowId, 'extra_field');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toEqual({ any: 'value' });
			}
		});
	});

	describe('getRow (validated)', () => {
		test('returns valid for correct row', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'title', 'Hello');
			tableStore.set(rowId, 'views', 100);
			tableStore.set(rowId, 'status', 'draft');

			const result = tableStore.getRow(rowId);
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.id).toBe(rowId);
				expect(result.row.cells.title).toBe('Hello');
				expect(result.row.cells.views).toBe(100);
			}
		});

		test('returns invalid for row with wrong types', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'title', 123); // Wrong type
			tableStore.set(rowId, 'views', 'not a number'); // Wrong type

			const result = tableStore.getRow(rowId);
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.tableName).toBe('posts');
			}
		});

		test('returns not_found for missing row', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const result = tableStore.getRow('nonexistent');
			expect(result.status).toBe('not_found');
		});
	});

	describe('getAll (validated)', () => {
		test('returns mix of valid and invalid rows', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			// Valid row
			const row1 = tableStore.createRow();
			tableStore.set(row1, 'title', 'Valid');
			tableStore.set(row1, 'views', 100);

			// Invalid row
			const row2 = tableStore.createRow();
			tableStore.set(row2, 'title', 'Also Valid');
			tableStore.set(row2, 'views', 'invalid');

			const results = tableStore.getAll();
			expect(results.length).toBe(2);

			const valid = results.filter((r) => r.status === 'valid');
			const invalid = results.filter((r) => r.status === 'invalid');
			expect(valid.length).toBe(1);
			expect(invalid.length).toBe(1);
		});
	});

	describe('getAllValid', () => {
		test('filters out invalid rows', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			// Valid row
			const row1 = tableStore.createRow();
			tableStore.set(row1, 'title', 'Valid');
			tableStore.set(row1, 'views', 100);

			// Invalid row
			const row2 = tableStore.createRow();
			tableStore.set(row2, 'title', 123); // Wrong type

			const validRows = tableStore.getAllValid();
			expect(validRows.length).toBe(1);
			expect(validRows[0]?.cells.title).toBe('Valid');
		});
	});

	describe('getAllInvalid', () => {
		test('returns only invalid rows with errors', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			// Valid row
			const row1 = tableStore.createRow();
			tableStore.set(row1, 'title', 'Valid');

			// Invalid row
			const row2 = tableStore.createRow();
			tableStore.set(row2, 'views', 'not a number');

			const invalidRows = tableStore.getAllInvalid();
			expect(invalidRows.length).toBe(1);
			expect(invalidRows[0]?.id).toBe(row2);
			expect(invalidRows[0]?.errors.length).toBeGreaterThan(0);
		});
	});

	describe('raw access', () => {
		test('provides unvalidated access to cells', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'views', 'not a number'); // Invalid value

			// raw.get returns the value without validation
			const rawValue = tableStore.raw.get(rowId, 'views');
			expect(rawValue).toBe('not a number');

			// But validated get returns invalid status
			const validatedResult = tableStore.get(rowId, 'views');
			expect(validatedResult.status).toBe('invalid');
		});

		test('raw.getRow returns row without validation', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'title', 123); // Invalid
			tableStore.set(rowId, 'views', 'string'); // Invalid

			const rawRow = tableStore.raw.getRow(rowId);
			expect(rawRow).toBeDefined();
			expect(rawRow?.title).toBe(123);
			expect(rawRow?.views).toBe('string');
		});

		test('raw.getRows returns all rows without validation', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			tableStore.set('row1', 'title', 'Valid');
			tableStore.set('row2', 'title', 123); // Invalid

			const rawRows = tableStore.raw.getRows();
			expect(rawRows.length).toBe(2);
		});
	});

	describe('schema property', () => {
		test('exposes schema on store', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			expect(tableStore.schema).toBe(postsSchema);
			expect(tableStore.tableId).toBe('posts');
		});
	});

	describe('select validation', () => {
		test('validates select options correctly', () => {
			const { tableStore } = createTestStore('posts', postsSchema);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'status', 'draft');

			const validResult = tableStore.get(rowId, 'status');
			expect(validResult.status).toBe('valid');

			tableStore.set(rowId, 'status', 'invalid-status');
			const invalidResult = tableStore.get(rowId, 'status');
			expect(invalidResult.status).toBe('invalid');
		});
	});
});

describe('TableStore without schema (dynamic tables)', () => {
	test('all values pass validation', () => {
		const { tableStore } = createTestStore('dynamic');

		const rowId = tableStore.createRow();
		tableStore.set(rowId, 'anything', { complex: 'object' });
		tableStore.set(rowId, 'number', 42);
		tableStore.set(rowId, 'array', [1, 2, 3]);

		const anythingResult = tableStore.get(rowId, 'anything');
		expect(anythingResult.status).toBe('valid');

		const rowResult = tableStore.getRow(rowId);
		expect(rowResult.status).toBe('valid');
	});

	test('getAllInvalid returns empty array', () => {
		const { tableStore } = createTestStore('dynamic');

		tableStore.set('row1', 'field', 'value');
		tableStore.set('row2', 'field', 123);

		const invalid = tableStore.getAllInvalid();
		expect(invalid.length).toBe(0);
	});

	test('getAllValid returns all rows', () => {
		const { tableStore } = createTestStore('dynamic');

		tableStore.set('row1', 'field', 'value');
		tableStore.set('row2', 'field', 123);

		const valid = tableStore.getAllValid();
		expect(valid.length).toBe(2);
	});

	test('schema property is empty for dynamic tables', () => {
		const { tableStore } = createTestStore('dynamic');
		expect(tableStore.schema.name).toBe('dynamic');
		expect(tableStore.schema.fields).toEqual({});
	});
});
