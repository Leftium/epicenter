import { describe, test, expect } from 'bun:test';
import {
	generateRowId,
	validateId,
	validateFieldId,
	cellKey,
	parseCellKey,
	rowPrefix,
	hasPrefix,
	isReservedField,
	ROW_ORDER_FIELD,
	ROW_DELETED_AT_FIELD,
	RESERVED_FIELDS,
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
			"tableId cannot contain ':' character: \"invalid:id\"",
		);
		expect(() => validateId(':leading', 'fieldId')).toThrow(
			"fieldId cannot contain ':' character",
		);
		expect(() => validateId('trailing:', 'rowId')).toThrow(
			"rowId cannot contain ':' character",
		);
	});
});

describe('validateFieldId', () => {
	test('accepts valid field ids', () => {
		expect(() => validateFieldId('title')).not.toThrow();
		expect(() => validateFieldId('my_field')).not.toThrow();
		expect(() => validateFieldId('field123')).not.toThrow();
	});

	test('rejects reserved field names', () => {
		expect(() => validateFieldId('_order')).toThrow(
			'fieldId "_order" is reserved',
		);
		expect(() => validateFieldId('_deletedAt')).toThrow(
			'fieldId "_deletedAt" is reserved',
		);
	});

	test('rejects field ids with colon', () => {
		expect(() => validateFieldId('invalid:field')).toThrow(
			"fieldId cannot contain ':' character",
		);
	});
});

describe('reserved fields', () => {
	test('ROW_ORDER_FIELD is _order', () => {
		expect(ROW_ORDER_FIELD).toBe('_order');
	});

	test('ROW_DELETED_AT_FIELD is _deletedAt', () => {
		expect(ROW_DELETED_AT_FIELD).toBe('_deletedAt');
	});

	test('RESERVED_FIELDS contains both', () => {
		expect(RESERVED_FIELDS).toContain('_order');
		expect(RESERVED_FIELDS).toContain('_deletedAt');
	});

	test('isReservedField identifies reserved fields', () => {
		expect(isReservedField('_order')).toBe(true);
		expect(isReservedField('_deletedAt')).toBe(true);
		expect(isReservedField('title')).toBe(false);
		expect(isReservedField('_other')).toBe(false);
	});
});

describe('key construction', () => {
	test('cellKey creates correct format (rowId:fieldId)', () => {
		expect(cellKey('abc123', 'title')).toBe('abc123:title');
		expect(cellKey('row1', 'views')).toBe('row1:views');
		expect(cellKey('row1', '_order')).toBe('row1:_order');
	});
});

describe('key parsing', () => {
	test('parseCellKey extracts components', () => {
		const result = parseCellKey('abc123:title');
		expect(result).toEqual({
			rowId: 'abc123',
			fieldId: 'title',
		});
	});

	test('parseCellKey handles fieldId with special characters', () => {
		// Field ID could contain underscore
		const result = parseCellKey('row1:my_field');
		expect(result).toEqual({
			rowId: 'row1',
			fieldId: 'my_field',
		});
	});

	test('parseCellKey throws on invalid format', () => {
		expect(() => parseCellKey('invalid')).toThrow(
			'Invalid cell key format: "invalid"',
		);
	});
});

describe('prefix utilities', () => {
	test('rowPrefix creates correct format (rowId:)', () => {
		expect(rowPrefix('row1')).toBe('row1:');
		expect(rowPrefix('abc123')).toBe('abc123:');
	});

	test('hasPrefix checks correctly', () => {
		expect(hasPrefix('row1:title', 'row1:')).toBe(true);
		expect(hasPrefix('row1:views', 'row1:')).toBe(true);
		expect(hasPrefix('row2:title', 'row1:')).toBe(false);
		expect(hasPrefix('row1', 'row1:')).toBe(false);
	});
});
