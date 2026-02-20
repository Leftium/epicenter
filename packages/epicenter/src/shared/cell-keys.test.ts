/**
 * Cell Keys Utility Tests
 *
 * These tests verify the key format helpers that compose and parse row/column
 * addressing strings. They protect separator rules so row identifiers remain
 * unambiguous even when column identifiers contain colons.
 *
 * Key behaviors:
 * - Key construction and parsing round-trip valid row/column combinations.
 * - Invalid keys without separators or with invalid row ids fail fast.
 */
import { describe, expect, test } from 'bun:test';
import { CellKey, extractRowId, parseCellKey, RowPrefix } from './cell-keys';

describe('cell-keys', () => {
	describe('CellKey', () => {
		test('composes rowId and columnId', () => {
			expect(CellKey('row-1', 'title')).toBe('row-1:title');
		});

		test('CellKey output parses back to original rowId and columnId', () => {
			const key = CellKey('row-1', 'col-a');
			const parsed = parseCellKey(key);
			expect(parsed).toEqual({ rowId: 'row-1', columnId: 'col-a' });
		});

		test('allows colon in columnId', () => {
			expect(CellKey('row-1', 'nested:column:id')).toBe(
				'row-1:nested:column:id',
			);
		});

		test('throws if rowId contains colon', () => {
			expect(() => CellKey('row:1', 'title')).toThrow(
				'rowId cannot contain \':\': "row:1"',
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

	describe('RowPrefix', () => {
		test('appends separator', () => {
			expect(RowPrefix('row-1')).toBe('row-1:');
		});

		test('throws if rowId contains colon', () => {
			expect(() => RowPrefix('row:1')).toThrow(
				'rowId cannot contain \':\': "row:1"',
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
