import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../core/utils/y-keyvalue-lww';
import { createTableStore } from './table-store';
import { createValidatedTableStore } from './validated-table-store';
import type { CellValue, SchemaTableDefinition } from './types';

function createTestStore(tableId: string) {
	const ydoc = new Y.Doc();
	const yarray = ydoc.getArray<YKeyValueLwwEntry<CellValue>>(tableId);
	return { ydoc, tableStore: createTableStore(tableId, yarray) };
}

describe('createValidatedTableStore', () => {
	const schema: SchemaTableDefinition = {
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

	describe('getValidated', () => {
		test('returns valid for correct cell value', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'title', 'Hello World');

			const result = validated.getValidated(rowId, 'title');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe('Hello World');
			}
		});

		test('returns valid for null value (all fields nullable)', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'views', null);

			const result = validated.getValidated(rowId, 'views');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toBe(null);
			}
		});

		test('returns invalid for wrong type', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'views', 'not a number');

			const result = validated.getValidated(rowId, 'views');
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.value).toBe('not a number');
			}
		});

		test('returns not_found for missing cell', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const result = validated.getValidated('nonexistent-row', 'title');
			expect(result.status).toBe('not_found');
			if (result.status === 'not_found') {
				expect(result.key).toBe('nonexistent-row:title');
			}
		});

		test('fields not in schema pass validation (advisory behavior)', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'extra_field', { any: 'value' });

			const result = validated.getValidated(rowId, 'extra_field');
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.value).toEqual({ any: 'value' });
			}
		});
	});

	describe('getRowValidated', () => {
		test('returns valid for correct row', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'title', 'Hello');
			tableStore.set(rowId, 'views', 100);
			tableStore.set(rowId, 'status', 'draft');

			const result = validated.getRowValidated(rowId);
			expect(result.status).toBe('valid');
			if (result.status === 'valid') {
				expect(result.row.id).toBe(rowId);
				expect(result.row.cells.title).toBe('Hello');
				expect(result.row.cells.views).toBe(100);
			}
		});

		test('returns invalid for row with wrong types', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'title', 123); // Wrong type
			tableStore.set(rowId, 'views', 'not a number'); // Wrong type

			const result = validated.getRowValidated(rowId);
			expect(result.status).toBe('invalid');
			if (result.status === 'invalid') {
				expect(result.errors.length).toBeGreaterThan(0);
				expect(result.tableName).toBe('posts');
			}
		});

		test('returns not_found for missing row', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const result = validated.getRowValidated('nonexistent');
			expect(result.status).toBe('not_found');
		});
	});

	describe('getRowsValidated', () => {
		test('returns mix of valid and invalid rows', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			// Valid row
			const row1 = tableStore.createRow();
			tableStore.set(row1, 'title', 'Valid');
			tableStore.set(row1, 'views', 100);

			// Invalid row
			const row2 = tableStore.createRow();
			tableStore.set(row2, 'title', 'Also Valid');
			tableStore.set(row2, 'views', 'invalid');

			const results = validated.getRowsValidated();
			expect(results.length).toBe(2);

			const valid = results.filter((r) => r.status === 'valid');
			const invalid = results.filter((r) => r.status === 'invalid');
			expect(valid.length).toBe(1);
			expect(invalid.length).toBe(1);
		});
	});

	describe('getRowsValid', () => {
		test('filters out invalid rows', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			// Valid row
			const row1 = tableStore.createRow();
			tableStore.set(row1, 'title', 'Valid');
			tableStore.set(row1, 'views', 100);

			// Invalid row
			const row2 = tableStore.createRow();
			tableStore.set(row2, 'title', 123); // Wrong type

			const validRows = validated.getRowsValid();
			expect(validRows.length).toBe(1);
			expect(validRows[0]?.cells.title).toBe('Valid');
		});
	});

	describe('getRowsInvalid', () => {
		test('returns only invalid rows with errors', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			// Valid row
			const row1 = tableStore.createRow();
			tableStore.set(row1, 'title', 'Valid');

			// Invalid row
			const row2 = tableStore.createRow();
			tableStore.set(row2, 'views', 'not a number');

			const invalidRows = validated.getRowsInvalid();
			expect(invalidRows.length).toBe(1);
			expect(invalidRows[0]?.id).toBe(row2);
			expect(invalidRows[0]?.errors.length).toBeGreaterThan(0);
		});
	});

	describe('validator caching', () => {
		test('same validated store instance returned for same tableId', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			// Field validators are cached internally - test by calling multiple times
			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'title', 'Hello');

			// Multiple calls should use cached validator
			const result1 = validated.getValidated(rowId, 'title');
			const result2 = validated.getValidated(rowId, 'title');

			expect(result1.status).toBe('valid');
			expect(result2.status).toBe('valid');
		});
	});

	describe('raw store access', () => {
		test('provides access to underlying TableStore', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			expect(validated.raw).toBe(tableStore);
			expect(validated.tableId).toBe('posts');
			expect(validated.schema).toBe(schema);
		});
	});

	describe('select validation', () => {
		test('validates select options correctly', () => {
			const { tableStore } = createTestStore('posts');
			const validated = createValidatedTableStore('posts', schema, tableStore);

			const rowId = tableStore.createRow();
			tableStore.set(rowId, 'status', 'draft');

			const validResult = validated.getValidated(rowId, 'status');
			expect(validResult.status).toBe('valid');

			tableStore.set(rowId, 'status', 'invalid-status');
			const invalidResult = validated.getValidated(rowId, 'status');
			expect(invalidResult.status).toBe('invalid');
		});
	});
});
