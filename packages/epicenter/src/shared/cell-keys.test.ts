import { describe, expect, test } from 'bun:test';
import { cellKey, extractRowId, parseCellKey, rowPrefix } from './cell-keys';

describe('cell-keys', () => {
	describe('cellKey', () => {
		test('composes rowId and columnId', () => {
			expect(cellKey('row-1', 'title')).toBe('row-1:title');
		});

		test('roundtrips with parseCellKey', () => {
			const key = cellKey('row-1', 'col-a');
			const parsed = parseCellKey(key);
			expect(parsed).toEqual({ rowId: 'row-1', columnId: 'col-a' });
		});

		test('allows colon in columnId', () => {
			expect(cellKey('row-1', 'nested:column:id')).toBe(
				'row-1:nested:column:id',
			);
		});

		test('throws if rowId contains colon', () => {
			expect(() => cellKey('row:1', 'title')).toThrow(
				"rowId cannot contain ':': \"row:1\"",
			);
		});
	});

	describe('parseCellKey', () => {
		test('parses simple key', () => {
			expect(parseCellKey('row-1:title')).toEqual({
				rowId: 'row-1',
				columnId: 'title',
			});
		});

		test('splits on first colon only', () => {
			expect(parseCellKey('row-1:nested:column:id')).toEqual({
				rowId: 'row-1',
				columnId: 'nested:column:id',
			});
		});

		test('throws on missing separator', () => {
			expect(() => parseCellKey('no-separator')).toThrow(
				'Invalid cell key: "no-separator"',
			);
		});
	});

	describe('rowPrefix', () => {
		test('appends separator', () => {
			expect(rowPrefix('row-1')).toBe('row-1:');
		});

		test('throws if rowId contains colon', () => {
			expect(() => rowPrefix('row:1')).toThrow(
				"rowId cannot contain ':': \"row:1\"",
			);
		});
	});

	describe('extractRowId', () => {
		test('extracts rowId from cell key', () => {
			expect(extractRowId('row-1:title')).toBe('row-1');
		});

		test('extracts rowId when columnId contains colons', () => {
			expect(extractRowId('row-1:nested:column:id')).toBe('row-1');
		});

		test('throws on missing separator', () => {
			expect(() => extractRowId('no-separator')).toThrow(
				'Invalid cell key: "no-separator"',
			);
		});
	});
});
