/**
 * Key Encoding Utilities for Cell Workspace
 *
 * With Option B architecture (one Y.Array per table), keys are simple:
 * - Cell key: `{rowId}:{fieldId}`
 *
 * @packageDocumentation
 */

import { customAlphabet } from 'nanoid';
import type { Brand } from 'wellcrafted/brand';

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const KEY_SEPARATOR = ':' as const;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// ════════════════════════════════════════════════════════════════════════════
// Branded Types
// ════════════════════════════════════════════════════════════════════════════

/** Branded string for row identifiers. */
export type RowId = string & Brand<'RowId'>;

/** Branded string for field identifiers. */
export type FieldId = string & Brand<'FieldId'>;

/** Template literal type for cell keys: `{RowId}:{FieldId}` */
export type CellKey = `${RowId}${typeof KEY_SEPARATOR}${FieldId}`;

// ════════════════════════════════════════════════════════════════════════════
// ID Generation
// ════════════════════════════════════════════════════════════════════════════

const nanoid = customAlphabet(ALPHABET, 12);

/**
 * Generate a unique row ID.
 *
 * @returns A 12-character alphanumeric branded RowId
 *
 * @example
 * ```ts
 * const rowId = generateRowId(); // e.g., 'v1stgxr8z5jd' as RowId
 * ```
 */
export function generateRowId(): RowId {
	return nanoid() as RowId;
}

// ════════════════════════════════════════════════════════════════════════════
// ID Validation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate that an ID does not contain the separator character.
 *
 * @param id - The ID to validate
 * @param type - A description of the ID type for error messages
 * @throws Error if the ID contains the separator
 */
export function validateId(id: string, type: string): void {
	if (id.includes(KEY_SEPARATOR)) {
		throw new Error(`${type} cannot contain '${KEY_SEPARATOR}' character: "${id}"`);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Key Construction
// ════════════════════════════════════════════════════════════════════════════

/**
 * Construct a cell key from row and field IDs.
 *
 * @param rowId - The row identifier
 * @param fieldId - The field identifier
 * @returns Branded CellKey in format `{rowId}:{fieldId}`
 *
 * @example
 * ```ts
 * cellKey(rowId, 'title' as FieldId); // 'abc123:title' as CellKey
 * ```
 */
export function cellKey(rowId: RowId, fieldId: FieldId): CellKey {
	return `${rowId}${KEY_SEPARATOR}${fieldId}` as CellKey;
}

// ════════════════════════════════════════════════════════════════════════════
// Key Parsing
// ════════════════════════════════════════════════════════════════════════════

/** Parsed cell key components. */
export interface ParsedCellKey {
	rowId: RowId;
	fieldId: FieldId;
}

/**
 * Parse a cell key into its component IDs.
 *
 * @param key - Key in format `{rowId}:{fieldId}`
 * @returns Object with branded rowId and fieldId
 * @throws Error if key format is invalid
 */
export function parseCellKey(key: CellKey | string): ParsedCellKey {
	const separatorIndex = key.indexOf(KEY_SEPARATOR);
	if (separatorIndex === -1) {
		throw new Error(
			`Invalid cell key format: "${key}" (expected "rowId${KEY_SEPARATOR}fieldId")`,
		);
	}
	return {
		rowId: key.slice(0, separatorIndex) as RowId,
		fieldId: key.slice(separatorIndex + 1) as FieldId,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Prefix Utilities
// ════════════════════════════════════════════════════════════════════════════

/** Prefix type for row-scoped key scanning. */
export type RowPrefix = `${RowId}${typeof KEY_SEPARATOR}`;

/**
 * Create a prefix for scanning all cells belonging to a row.
 *
 * @param rowId - The row identifier
 * @returns Typed prefix string `{rowId}:`
 */
export function rowPrefix(rowId: RowId): RowPrefix {
	return `${rowId}${KEY_SEPARATOR}` as RowPrefix;
}

/**
 * Check if a key starts with a given prefix.
 */
export function hasPrefix(key: string, prefix: string): boolean {
	return key.startsWith(prefix);
}
