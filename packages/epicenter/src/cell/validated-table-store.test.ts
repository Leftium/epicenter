import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../core/utils/y-keyvalue-lww';
import { createTableHelper } from './table-helper';
import type { CellValue, SchemaTableDefinition } from './types';

function createTestStore(
	tableId: string,
	schema: SchemaTableDefinition = { name: tableId, fields: {} },
) {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<YKeyValueLwwEntry<CellValue>>(tableId);
	return { ydoc, tableHelper: createTableHelper(tableId, yarray, schema) };
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

describe('TableHelper with schema (consolidated API)', () => {
	describe('get (validated)', () => {
		test('returns valid for correct cell value', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'title', 'Hello World');

			const result = tableHelper.get(rowId, 'title');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('Hello World');
			}
		});

		test('returns valid for null value (all fields nullable)', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'views', null);

			const result = tableHelper.get(rowId, 'views');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(null);
			}
		});

		test('returns invalid for wrong type', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'views', 'not a number');

			const result = tableHelper.get(rowId, 'views');
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.value).toBe('not a number');
			}
		});

		test('returns not_found for missing cell', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const result = tableHelper.get('nonexistent-row', 'title');
			expect(result.status).toBe('not_found');
			if (result.status === 'not_found') {
				expect(result.key).toBe('nonexistent-row:title');
			}
		});

		test('fields not in schema pass validation (advisory behavior)', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'extra_field', { any: 'value' });

			const result = tableHelper.get(rowId, 'extra_field');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toEqual({ any: 'value' });
			}
		});
	});

	describe('getRow (validated)', () => {
		test('returns valid for correct row', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'title', 'Hello');
			tableHelper.set(rowId, 'views', 100);
			tableHelper.set(rowId, 'status', 'draft');

			const result = tableHelper.getRow(rowId);
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.id).toBe(rowId);
				expect(result.row.cells.title).toBe('Hello');
				expect(result.row.cells.views).toBe(100);
			}
		});

		test('returns invalid for row with wrong types', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'title', 123); // Wrong type
			tableHelper.set(rowId, 'views', 'not a number'); // Wrong type

			const result = tableHelper.getRow(rowId);
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.tableName).toBe('posts');
			}
		});

		test('returns not_found for missing row', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const result = tableHelper.getRow('nonexistent');
			expect(result.status).toBe('not_found');
		});
	});

	describe('getAll (validated)', () => {
		test('returns mix of valid and invalid rows', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			// Valid row
			const row1 = tableHelper.createRow();
			tableHelper.set(row1, 'title', 'Valid');
			tableHelper.set(row1, 'views', 100);

			// Invalid row
			const row2 = tableHelper.createRow();
			tableHelper.set(row2, 'title', 'Also Valid');
			tableHelper.set(row2, 'views', 'invalid');

			const results = tableHelper.getAll();
			expect(results.length).toBe(2);

			const valid = results.filter((r) => r.status === 'valid');
			const invalid = results.filter((r) => r.status === 'invalid');
			expect(valid.length).toBe(1);
			expect(invalid.length).toBe(1);
		});
	});

	describe('getAllValid', () => {
		test('filters out invalid rows', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			// Valid row
			const row1 = tableHelper.createRow();
			tableHelper.set(row1, 'title', 'Valid');
			tableHelper.set(row1, 'views', 100);

			// Invalid row
			const row2 = tableHelper.createRow();
			tableHelper.set(row2, 'title', 123); // Wrong type

			const validRows = tableHelper.getAllValid();
			expect(validRows.length).toBe(1);
			expect(validRows[0]?.cells.title).toBe('Valid');
		});
	});

	describe('getAllInvalid', () => {
		test('returns only invalid rows with errors', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			// Valid row
			const row1 = tableHelper.createRow();
			tableHelper.set(row1, 'title', 'Valid');

			// Invalid row
			const row2 = tableHelper.createRow();
			tableHelper.set(row2, 'views', 'not a number');

			const invalidRows = tableHelper.getAllInvalid();
			expect(invalidRows.length).toBe(1);
			expect(invalidRows[0]?.id).toBe(row2);
			expect(invalidRows[0]?.errors.length).toBeGreaterThan(0);
		});
	});

	describe('value access on invalid results', () => {
		test('invalid cell result still contains the raw value', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'views', 'not a number'); // Invalid value

			// Validated get returns invalid status but still includes the value
			const result = tableHelper.get(rowId, 'views');
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.value).toBe('not a number');
			}
		});

		test('invalid row result still contains the raw row data', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'title', 123); // Invalid
			tableHelper.set(rowId, 'views', 'string'); // Invalid

			const result = tableHelper.getRow(rowId);
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				// For invalid rows, .row contains the raw cells data
				const cells = result.row as Record<string, unknown>;
				expect(cells.title).toBe(123);
				expect(cells.views).toBe('string');
			}
		});

		test('getAll returns all rows including invalid ones', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			tableHelper.set('row1', 'title', 'Valid');
			tableHelper.set('row2', 'title', 123); // Invalid

			const results = tableHelper.getAll();
			expect(results.length).toBe(2);
			// Both valid and invalid rows are returned
			expect(results.some((r) => r.status === 'valid')).toBe(true);
			expect(results.some((r) => r.status === 'invalid')).toBe(true);
		});
	});

	describe('schema property', () => {
		test('exposes schema on store', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			expect(tableHelper.schema).toBe(postsSchema);
			expect(tableHelper.tableId).toBe('posts');
		});
	});

	describe('select validation', () => {
		test('validates select options correctly', () => {
			const { tableHelper } = createTestStore('posts', postsSchema);

			const rowId = tableHelper.createRow();
			tableHelper.set(rowId, 'status', 'draft');

			const validResult = tableHelper.get(rowId, 'status');
			expect(validResult.status).toBe('valid');

			tableHelper.set(rowId, 'status', 'invalid-status');
			const invalidResult = tableHelper.get(rowId, 'status');
			expect(invalidResult.status).toBe('invalid');
		});
	});
});

describe('TableHelper without schema (dynamic tables)', () => {
	test('all values pass validation', () => {
		const { tableHelper } = createTestStore('dynamic');

		const rowId = tableHelper.createRow();
		tableHelper.set(rowId, 'anything', { complex: 'object' });
		tableHelper.set(rowId, 'number', 42);
		tableHelper.set(rowId, 'array', [1, 2, 3]);

		const anythingResult = tableHelper.get(rowId, 'anything');
		expect(anythingResult.status).toBe('valid');

		const rowResult = tableHelper.getRow(rowId);
		expect(rowResult.status).toBe('valid');
	});

	test('getAllInvalid returns empty array', () => {
		const { tableHelper } = createTestStore('dynamic');

		tableHelper.set('row1', 'field', 'value');
		tableHelper.set('row2', 'field', 123);

		const invalid = tableHelper.getAllInvalid();
		expect(invalid.length).toBe(0);
	});

	test('getAllValid returns all rows', () => {
		const { tableHelper } = createTestStore('dynamic');

		tableHelper.set('row1', 'field', 'value');
		tableHelper.set('row2', 'field', 123);

		const valid = tableHelper.getAllValid();
		expect(valid.length).toBe(2);
	});

	test('schema property is empty for dynamic tables', () => {
		const { tableHelper } = createTestStore('dynamic');
		expect(tableHelper.schema.name).toBe('dynamic');
		expect(tableHelper.schema.fields).toEqual({});
	});
});
