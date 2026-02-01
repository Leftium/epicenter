import type { Brand } from 'wellcrafted/brand';
import type { Id } from '../../core/schema/fields/id.js';
import { Id as createId } from '../../core/schema/fields/id.js';

const KEY_SEPARATOR = ':' as const;

/**
 * Branded type for field identifiers.
 *
 * Ensures type safety when working with field IDs in cell keys.
 * Use the {@link FieldId} constructor to create branded field IDs.
 *
 * @example
 * ```typescript
 * const fieldId = FieldId('name');
 * ```
 */
export type FieldId = string & Brand<'FieldId'>;

/**
 * Template literal type for cell keys.
 *
 * Represents a compound key in the format `rowId:fieldId`.
 * Use the {@link CellKey} constructor to create cell keys safely.
 *
 * @example
 * ```typescript
 * const key: CellKey = CellKey(Id('row-1'), FieldId('name'));
 * // key is "row-1:name"
 * ```
 */
export type CellKey = `${Id}${typeof KEY_SEPARATOR}${FieldId}`;

/**
 * Template literal type for row prefixes.
 *
 * Represents a prefix for scanning all cells in a row.
 * Format is `rowId:` (includes the separator).
 * Use the {@link RowPrefix} constructor to create row prefixes safely.
 *
 * @example
 * ```typescript
 * const prefix: RowPrefix = RowPrefix(Id('row-1'));
 * // prefix is "row-1:"
 * ```
 */
export type RowPrefix = `${Id}${typeof KEY_SEPARATOR}`;

/**
 * Create a branded FieldId from a string.
 *
 * Validates that the ID does not contain the key separator character.
 * Throws an error if validation fails.
 *
 * @param id - The field identifier string
 * @returns A branded FieldId
 * @throws If the ID contains the ':' separator character
 *
 * @example
 * ```typescript
 * const fieldId = FieldId('email');
 * const cellKey = CellKey(Id('row-1'), fieldId);
 * ```
 */
export function FieldId(id: string): FieldId {
	if (id.includes(KEY_SEPARATOR)) {
		throw new Error(`FieldId cannot contain '${KEY_SEPARATOR}': "${id}"`);
	}
	return id as FieldId;
}

/**
 * Create a cell key from a row ID and field ID.
 *
 * Combines a row ID and field ID into a compound key using ':' as separator.
 * Both IDs must be branded (use {@link Id} and {@link FieldId} constructors).
 *
 * @param rowId - The branded row identifier
 * @param fieldId - The branded field identifier
 * @returns A cell key in the format `rowId:fieldId`
 *
 * @example
 * ```typescript
 * const key = CellKey(Id('row-1'), FieldId('name'));
 * // key is "row-1:name"
 * ```
 */
export function CellKey(rowId: Id, fieldId: FieldId): CellKey {
	return `${rowId}${KEY_SEPARATOR}${fieldId}` as CellKey;
}

/**
 * Create a row prefix for scanning all cells in a row.
 *
 * Useful for range queries that need to find all cells belonging to a specific row.
 * The prefix includes the separator character.
 *
 * @param rowId - The branded row identifier
 * @returns A row prefix in the format `rowId:`
 *
 * @example
 * ```typescript
 * const prefix = RowPrefix(Id('row-1'));
 * // prefix is "row-1:"
 * // Can be used to find all keys starting with "row-1:"
 * ```
 */
export function RowPrefix(rowId: Id): RowPrefix {
	return `${rowId}${KEY_SEPARATOR}` as RowPrefix;
}

/**
 * Parse a cell key into its row ID and field ID components.
 *
 * Splits a cell key on the ':' separator and returns branded components.
 * Throws an error if the key format is invalid.
 *
 * @param key - The cell key to parse (format: `rowId:fieldId`)
 * @returns An object with branded `rowId` and `fieldId` properties
 * @throws If the key does not contain exactly one ':' separator
 *
 * @example
 * ```typescript
 * const { rowId, fieldId } = parseCellKey('row-1:name');
 * // rowId is Id('row-1')
 * // fieldId is FieldId('name')
 * ```
 */
export function parseCellKey(key: string): { rowId: Id; fieldId: FieldId } {
	const parts = key.split(KEY_SEPARATOR);
	if (parts.length !== 2) {
		throw new Error(
			`Invalid cell key format: "${key}". Expected format: "rowId:fieldId"`,
		);
	}
	const [rowIdStr, fieldIdStr] = parts;
	if (!rowIdStr || !fieldIdStr) {
		throw new Error(`Invalid cell key format: "${key}"`);
	}
	return {
		rowId: createId(rowIdStr),
		fieldId: FieldId(fieldIdStr),
	};
}

