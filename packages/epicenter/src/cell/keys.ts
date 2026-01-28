/**
 * Key Encoding Utilities for Cell Workspace
 *
 * Keys use ':' as a separator. IDs must not contain ':'.
 *
 * Key formats:
 * - rows:  `{tableId}:{rowId}`
 * - cells: `{tableId}:{rowId}:{fieldId}`
 *
 * @packageDocumentation
 */

import { customAlphabet } from 'nanoid';

// ════════════════════════════════════════════════════════════════════════════
// ID Generation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Alphabet for generating row IDs.
 * Uses lowercase alphanumeric for URL-safety and readability.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generate a random row ID.
 * Uses 12 characters for sufficient uniqueness (36^12 possibilities).
 */
const nanoid = customAlphabet(ALPHABET, 12);

/**
 * Generate a unique row ID.
 *
 * @returns A 12-character alphanumeric ID
 *
 * @example
 * ```ts
 * const rowId = generateRowId(); // e.g., 'v1stgxr8z5jd'
 * ```
 */
export function generateRowId(): string {
	return nanoid();
}

// ════════════════════════════════════════════════════════════════════════════
// ID Validation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate that an ID does not contain the separator character ':'.
 *
 * @param id - The ID to validate
 * @param type - A description of the ID type for error messages
 * @throws Error if the ID contains ':'
 */
export function validateId(id: string, type: string): void {
	if (id.includes(':')) {
		throw new Error(`${type} cannot contain ':' character: "${id}"`);
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Key Construction
// ════════════════════════════════════════════════════════════════════════════

/**
 * Construct a row key from table and row IDs.
 *
 * @param tableId - The table identifier
 * @param rowId - The row identifier
 * @returns Key in format `{tableId}:{rowId}`
 *
 * @example
 * ```ts
 * rowKey('posts', 'abc123'); // 'posts:abc123'
 * ```
 */
export function rowKey(tableId: string, rowId: string): string {
	return `${tableId}:${rowId}`;
}

/**
 * Construct a cell key from table, row, and field IDs.
 *
 * @param tableId - The table identifier
 * @param rowId - The row identifier
 * @param fieldId - The field identifier
 * @returns Key in format `{tableId}:{rowId}:{fieldId}`
 *
 * @example
 * ```ts
 * cellKey('posts', 'abc123', 'title'); // 'posts:abc123:title'
 * ```
 */
export function cellKey(
	tableId: string,
	rowId: string,
	fieldId: string,
): string {
	return `${tableId}:${rowId}:${fieldId}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Key Parsing
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse a row key into its component IDs.
 *
 * @param key - Key in format `{tableId}:{rowId}`
 * @returns Object with tableId and rowId
 * @throws Error if key format is invalid
 */
export function parseRowKey(key: string): { tableId: string; rowId: string } {
	const parts = key.split(':');
	if (parts.length !== 2) {
		throw new Error(
			`Invalid row key format: "${key}" (expected "tableId:rowId")`,
		);
	}
	const [tableId, rowId] = parts as [string, string];
	return { tableId, rowId };
}

/**
 * Parse a cell key into its component IDs.
 *
 * @param key - Key in format `{tableId}:{rowId}:{fieldId}`
 * @returns Object with tableId, rowId, and fieldId
 * @throws Error if key format is invalid
 */
export function parseCellKey(key: string): {
	tableId: string;
	rowId: string;
	fieldId: string;
} {
	const parts = key.split(':');
	if (parts.length !== 3) {
		throw new Error(
			`Invalid cell key format: "${key}" (expected "tableId:rowId:fieldId")`,
		);
	}
	const [tableId, rowId, fieldId] = parts as [string, string, string];
	return { tableId, rowId, fieldId };
}

// ════════════════════════════════════════════════════════════════════════════
// Prefix Utilities
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a prefix for scanning keys belonging to a table.
 *
 * @param tableId - The table identifier
 * @returns Prefix string `{tableId}:`
 */
export function tablePrefix(tableId: string): string {
	return `${tableId}:`;
}

/**
 * Create a prefix for scanning cell keys belonging to a specific row.
 *
 * @param tableId - The table identifier
 * @param rowId - The row identifier
 * @returns Prefix string `{tableId}:{rowId}:`
 */
export function rowCellPrefix(tableId: string, rowId: string): string {
	return `${tableId}:${rowId}:`;
}

/**
 * Check if a key starts with a given prefix.
 */
export function hasPrefix(key: string, prefix: string): boolean {
	return key.startsWith(prefix);
}

/**
 * Extract the ID portion after a prefix from a key.
 */
export function extractAfterPrefix(key: string, prefix: string): string {
	if (!key.startsWith(prefix)) {
		throw new Error(`Key "${key}" does not start with prefix "${prefix}"`);
	}
	return key.slice(prefix.length);
}
