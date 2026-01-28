import { describe, expect, test } from 'bun:test';
import {
	cellKey,
	type FieldId,
	generateRowId,
	hasPrefix,
	parseCellKey,
	type RowId,
	rowPrefix,
	validateId,
} from './keys';

describe('generateRowId', () => {
	test('generates 12-character alphanumeric id', () => {
		const id = generateRowId();
		expect(id).toHaveLength(12);
		expect(/^[a-z0-9]+$/.test(id)).toBe(true);
	});

	test('generates unique ids', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(generateRowId());
		}
		expect(ids.size).toBe(100);
	});
});

describe('validateId', () => {
	test('accepts valid ids', () => {
		expect(() => validateId('posts', 'tableId')).not.toThrow();
		expect(() => validateId('my_table', 'tableId')).not.toThrow();
		expect(() => validateId('table123', 'tableId')).not.toThrow();
		expect(() => validateId('a', 'tableId')).not.toThrow();
	});

	test('rejects ids containing colon', () => {
		expect(() => validateId('invalid:id', 'tableId')).toThrow(
			'tableId cannot contain \':\' character: "invalid:id"',
		);
		expect(() => validateId(':leading', 'fieldId')).toThrow(
			"fieldId cannot contain ':' character",
		);
		expect(() => validateId('trailing:', 'rowId')).toThrow(
			"rowId cannot contain ':' character",
		);
	});
});

describe('key construction', () => {
	test('cellKey creates correct format (rowId:fieldId)', () => {
		const key1 = cellKey('abc123' as RowId, 'title' as FieldId);
		const key2 = cellKey('row1' as RowId, 'views' as FieldId);
		expect<string>(key1).toBe('abc123:title');
		expect<string>(key2).toBe('row1:views');
	});
});

describe('key parsing', () => {
	test('parseCellKey extracts components', () => {
		const result = parseCellKey('abc123:title');
		expect<string>(result.rowId).toBe('abc123');
		expect<string>(result.fieldId).toBe('title');
	});

	test('parseCellKey handles fieldId with special characters', () => {
		// Field ID could contain underscore
		const result = parseCellKey('row1:my_field');
		expect<string>(result.rowId).toBe('row1');
		expect<string>(result.fieldId).toBe('my_field');
	});

	test('parseCellKey throws on invalid format', () => {
		expect(() => parseCellKey('invalid')).toThrow(
			'Invalid cell key format: "invalid"',
		);
	});
});

describe('prefix utilities', () => {
	test('rowPrefix creates correct format (rowId:)', () => {
		expect<string>(rowPrefix('row1' as RowId)).toBe('row1:');
		expect<string>(rowPrefix('abc123' as RowId)).toBe('abc123:');
	});

	test('hasPrefix checks correctly', () => {
		expect(hasPrefix('row1:title', 'row1:')).toBe(true);
		expect(hasPrefix('row1:views', 'row1:')).toBe(true);
		expect(hasPrefix('row2:title', 'row1:')).toBe(false);
		expect(hasPrefix('row1', 'row1:')).toBe(false);
	});
});
