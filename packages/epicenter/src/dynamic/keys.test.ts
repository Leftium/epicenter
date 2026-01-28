import { describe, expect, test } from 'bun:test';
import {
	cellKey,
	extractAfterPrefix,
	fieldKey,
	generateRowId,
	hasPrefix,
	parseCellKey,
	parseFieldKey,
	parseRowKey,
	rowCellPrefix,
	rowKey,
	tablePrefix,
	validateId,
} from './keys.js';

describe('generateRowId', () => {
	test('generates 12-character alphanumeric IDs', () => {
		const id = generateRowId();
		expect(id).toHaveLength(12);
		expect(id).toMatch(/^[a-z0-9]+$/);
	});

	test('generates unique IDs', () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) {
			ids.add(generateRowId());
		}
		expect(ids.size).toBe(1000);
	});
});

describe('validateId', () => {
	test('accepts valid IDs', () => {
		expect(() => validateId('posts', 'tableId')).not.toThrow();
		expect(() => validateId('my_table', 'tableId')).not.toThrow();
		expect(() => validateId('table123', 'tableId')).not.toThrow();
		expect(() => validateId('MyTable', 'tableId')).not.toThrow();
	});

	test('rejects IDs containing colon', () => {
		expect(() => validateId('my:table', 'tableId')).toThrow(
			'tableId cannot contain \':\' character: "my:table"',
		);
		expect(() => validateId(':prefix', 'fieldId')).toThrow(
			'fieldId cannot contain \':\' character: ":prefix"',
		);
		expect(() => validateId('suffix:', 'rowId')).toThrow(
			'rowId cannot contain \':\' character: "suffix:"',
		);
	});
});

describe('key construction', () => {
	test('fieldKey', () => {
		expect(fieldKey('posts', 'title')).toBe('posts:title');
		expect(fieldKey('users', 'email')).toBe('users:email');
	});

	test('rowKey', () => {
		expect(rowKey('posts', 'abc123')).toBe('posts:abc123');
		expect(rowKey('users', 'xyz789')).toBe('users:xyz789');
	});

	test('cellKey', () => {
		expect(cellKey('posts', 'abc123', 'title')).toBe('posts:abc123:title');
		expect(cellKey('users', 'xyz789', 'email')).toBe('users:xyz789:email');
	});
});

describe('key parsing', () => {
	describe('parseFieldKey', () => {
		test('parses valid field keys', () => {
			expect(parseFieldKey('posts:title')).toEqual({
				tableId: 'posts',
				fieldId: 'title',
			});
			expect(parseFieldKey('users:email')).toEqual({
				tableId: 'users',
				fieldId: 'email',
			});
		});

		test('throws on invalid format', () => {
			expect(() => parseFieldKey('posts')).toThrow('Invalid field key format');
			expect(() => parseFieldKey('posts:row:field')).toThrow(
				'Invalid field key format',
			);
		});
	});

	describe('parseRowKey', () => {
		test('parses valid row keys', () => {
			expect(parseRowKey('posts:abc123')).toEqual({
				tableId: 'posts',
				rowId: 'abc123',
			});
		});

		test('throws on invalid format', () => {
			expect(() => parseRowKey('posts')).toThrow('Invalid row key format');
			expect(() => parseRowKey('posts:row:extra')).toThrow(
				'Invalid row key format',
			);
		});
	});

	describe('parseCellKey', () => {
		test('parses valid cell keys', () => {
			expect(parseCellKey('posts:abc123:title')).toEqual({
				tableId: 'posts',
				rowId: 'abc123',
				fieldId: 'title',
			});
		});

		test('throws on invalid format', () => {
			expect(() => parseCellKey('posts:row')).toThrow(
				'Invalid cell key format',
			);
			expect(() => parseCellKey('posts:row:field:extra')).toThrow(
				'Invalid cell key format',
			);
		});
	});
});

describe('prefix utilities', () => {
	test('tablePrefix', () => {
		expect(tablePrefix('posts')).toBe('posts:');
	});

	test('rowCellPrefix', () => {
		expect(rowCellPrefix('posts', 'abc123')).toBe('posts:abc123:');
	});

	test('hasPrefix', () => {
		expect(hasPrefix('posts:title', 'posts:')).toBe(true);
		expect(hasPrefix('posts:title', 'users:')).toBe(false);
		expect(hasPrefix('posts:abc123:title', 'posts:abc123:')).toBe(true);
	});

	test('extractAfterPrefix', () => {
		expect(extractAfterPrefix('posts:title', 'posts:')).toBe('title');
		expect(extractAfterPrefix('posts:abc123:title', 'posts:abc123:')).toBe(
			'title',
		);
	});

	test('extractAfterPrefix throws on mismatch', () => {
		expect(() => extractAfterPrefix('posts:title', 'users:')).toThrow(
			'Key "posts:title" does not start with prefix "users:"',
		);
	});
});
