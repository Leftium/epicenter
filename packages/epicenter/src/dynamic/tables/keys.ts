import type { Brand } from 'wellcrafted/brand';

const KEY_SEPARATOR = ':' as const;

/**
 * Branded type for row identifiers.
 *
 * Ensures type safety when working with row IDs in cell keys.
 * Use the {@link RowId} constructor to create branded row IDs.
 *
 * @example
 * ```typescript
 * const rowId = RowId('row-123');
 * ```
 */
export type RowId = string & Brand<'RowId'>;

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
 * const key: CellKey = CellKey(RowId('row-1'), FieldId('name'));
 * // key is "row-1:name"
 * ```
 */
export type CellKey = `${RowId}${typeof KEY_SEPARATOR}${FieldId}`;

/**
 * Template literal type for row prefixes.
 *
 * Represents a prefix for scanning all cells in a row.
 * Format is `rowId:` (includes the separator).
 * Use the {@link RowPrefix} constructor to create row prefixes safely.
 *
 * @example
 * ```typescript
 * const prefix: RowPrefix = RowPrefix(RowId('row-1'));
 * // prefix is "row-1:"
 * ```
 */
export type RowPrefix = `${RowId}${typeof KEY_SEPARATOR}`;

/**
 * Create a branded RowId from a string.
 *
 * Validates that the ID does not contain the key separator character.
 * Throws an error if validation fails.
 *
 * @param id - The row identifier string
 * @returns A branded RowId
 * @throws If the ID contains the ':' separator character
 *
 * @example
 * ```typescript
 * const rowId = RowId('row-123');
 * const cellKey = CellKey(rowId, FieldId('name'));
 * ```
 */
export function RowId(id: string): RowId {
	validateId(id, 'RowId');
	return id as RowId;
}

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
 * const cellKey = CellKey(RowId('row-1'), fieldId);
 * ```
 */
export function FieldId(id: string): FieldId {
	validateId(id, 'FieldId');
	return id as FieldId;
}

/**
 * Create a cell key from a row ID and field ID.
 *
 * Combines a row ID and field ID into a compound key using ':' as separator.
 * Both IDs must be branded (use {@link RowId} and {@link FieldId} constructors).
 *
 * @param rowId - The branded row identifier
 * @param fieldId - The branded field identifier
 * @returns A cell key in the format `rowId:fieldId`
 *
 * @example
 * ```typescript
 * const key = CellKey(RowId('row-1'), FieldId('name'));
 * // key is "row-1:name"
 * ```
 */
export function CellKey(rowId: RowId, fieldId: FieldId): CellKey {
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
 * const prefix = RowPrefix(RowId('row-1'));
 * // prefix is "row-1:"
 * // Can be used to find all keys starting with "row-1:"
 * ```
 */
export function RowPrefix(rowId: RowId): RowPrefix {
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
 * // rowId is RowId('row-1')
 * // fieldId is FieldId('name')
 * ```
 */
export function parseCellKey(key: string): { rowId: RowId; fieldId: FieldId } {
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
		rowId: RowId(rowIdStr),
		fieldId: FieldId(fieldIdStr),
	};
}

/**
 * Check if a key starts with a given prefix.
 *
 * Useful for filtering keys by row prefix in range queries.
 *
 * @param key - The key to check
 * @param prefix - The prefix to match
 * @returns True if the key starts with the prefix, false otherwise
 *
 * @example
 * ```typescript
 * const prefix = RowPrefix(RowId('row-1'));
 * if (hasPrefix('row-1:name', prefix)) {
 *   // This cell belongs to row-1
 * }
 * ```
 */
export function hasPrefix(key: string, prefix: string): boolean {
	return key.startsWith(prefix);
}

/**
 * Validate that an ID does not contain the key separator character.
 *
 * Throws an error if the ID contains ':' since this would break cell key parsing.
 * Called automatically by {@link RowId} and {@link FieldId} constructors.
 *
 * @param id - The ID to validate
 * @param type - The type name (for error messages)
 * @throws If the ID contains the ':' separator character
 *
 * @example
 * ```typescript
 * validateId('row-1', 'RowId'); // OK
 * validateId('row:1', 'RowId'); // Throws error
 * ```
 */
export function validateId(id: string, type: string): void {
	if (id.includes(KEY_SEPARATOR)) {
		throw new Error(`${type} cannot contain '${KEY_SEPARATOR}': "${id}"`);
	}
}
