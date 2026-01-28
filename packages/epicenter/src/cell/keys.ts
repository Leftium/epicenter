/**
 * Key Encoding Utilities for Cell Workspace
 *
 * With Option B architecture (one Y.Array per table), keys are simple:
 * - Cell key: `{rowId}:{fieldId}`
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
 * Construct a cell key from row and field IDs.
 *
 * @param rowId - The row identifier
 * @param fieldId - The field identifier
 * @returns Key in format `{rowId}:{fieldId}`
 *
 * @example
 * ```ts
 * cellKey('abc123', 'title'); // 'abc123:title'
 * ```
 */
export function cellKey(rowId: string, fieldId: string): string {
	return `${rowId}:${fieldId}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Key Parsing
// ════════════════════════════════════════════════════════════════════════════

/**
 * Parse a cell key into its component IDs.
 *
 * @param key - Key in format `{rowId}:{fieldId}`
 * @returns Object with rowId and fieldId
 * @throws Error if key format is invalid
 */
export function parseCellKey(key: string): {
	rowId: string;
	fieldId: string;
} {
	const colonIndex = key.indexOf(':');
	if (colonIndex === -1) {
		throw new Error(
			`Invalid cell key format: "${key}" (expected "rowId:fieldId")`,
		);
	}
	return {
		rowId: key.slice(0, colonIndex),
		fieldId: key.slice(colonIndex + 1),
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Prefix Utilities
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a prefix for scanning all cells belonging to a row.
 *
 * @param rowId - The row identifier
 * @returns Prefix string `{rowId}:`
 */
export function rowPrefix(rowId: string): string {
	return `${rowId}:`;
}

/**
 * Check if a key starts with a given prefix.
 */
export function hasPrefix(key: string, prefix: string): boolean {
	return key.startsWith(prefix);
}
