import { describe, test, expect } from 'bun:test';
import {
	generateRowId,
	validateId,
	rowKey,
	cellKey,
	parseRowKey,
	parseCellKey,
	tablePrefix,
	rowCellPrefix,
	hasPrefix,
	extractAfterPrefix,
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

describe('key construction', () => {
	test('rowKey creates correct format', () => {
		expect(rowKey('posts', 'abc123')).toBe('posts:abc123');
		expect(rowKey('users', 'user_1')).toBe('users:user_1');
	});

	test('cellKey creates correct format', () => {
		expect(cellKey('posts', 'abc123', 'title')).toBe('posts:abc123:title');
		expect(cellKey('users', 'u1', 'name')).toBe('users:u1:name');
	});
});

describe('key parsing', () => {
	test('parseRowKey extracts components', () => {
		const result = parseRowKey('posts:abc123');
		expect(result).toEqual({ tableId: 'posts', rowId: 'abc123' });
	});

	test('parseRowKey throws on invalid format', () => {
		expect(() => parseRowKey('invalid')).toThrow(
			'Invalid row key format: "invalid"',
		);
		expect(() => parseRowKey('too:many:parts')).toThrow(
			'Invalid row key format',
		);
		expect(() => parseRowKey('')).toThrow('Invalid row key format');
	});

	test('parseCellKey extracts components', () => {
		const result = parseCellKey('posts:abc123:title');
		expect(result).toEqual({
			tableId: 'posts',
			rowId: 'abc123',
			fieldId: 'title',
		});
	});

	test('parseCellKey throws on invalid format', () => {
		expect(() => parseCellKey('invalid')).toThrow(
			'Invalid cell key format: "invalid"',
		);
		expect(() => parseCellKey('only:two')).toThrow(
			'Invalid cell key format',
		);
		expect(() => parseCellKey('too:many:parts:here')).toThrow(
			'Invalid cell key format',
		);
	});
});

describe('prefix utilities', () => {
	test('tablePrefix creates correct format', () => {
		expect(tablePrefix('posts')).toBe('posts:');
		expect(tablePrefix('users')).toBe('users:');
	});

	test('rowCellPrefix creates correct format', () => {
		expect(rowCellPrefix('posts', 'row1')).toBe('posts:row1:');
		expect(rowCellPrefix('users', 'u123')).toBe('users:u123:');
	});

	test('hasPrefix checks correctly', () => {
		expect(hasPrefix('posts:row1', 'posts:')).toBe(true);
		expect(hasPrefix('posts:row1:title', 'posts:row1:')).toBe(true);
		expect(hasPrefix('users:row1', 'posts:')).toBe(false);
		expect(hasPrefix('posts', 'posts:')).toBe(false);
	});

	test('extractAfterPrefix removes prefix', () => {
		expect(extractAfterPrefix('posts:row1', 'posts:')).toBe('row1');
		expect(extractAfterPrefix('posts:row1:title', 'posts:row1:')).toBe(
			'title',
		);
	});

	test('extractAfterPrefix throws if prefix not present', () => {
		expect(() => extractAfterPrefix('users:row1', 'posts:')).toThrow(
			'Key "users:row1" does not start with prefix "posts:"',
		);
	});
});
