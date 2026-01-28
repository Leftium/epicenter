/**
 * Key Encoding Utilities for Dynamic Workspace
 *
 * Keys use ':' as a separator. IDs must not contain ':'.
 *
 * Key formats:
 * - tables: `{tableId}`
 * - fields: `{tableId}:{fieldId}`
 * - rows:   `{tableId}:{rowId}`
 * - cells:  `{tableId}:{rowId}:{fieldId}`
 *
 * @packageDocumentation
 */

// Re-export branded types from cell/keys for use throughout dynamic module
export {
	type RowId,
	type FieldId,
	rowId,
	fieldId,
	generateRowId,
} from '../cell/keys.js';

// ════════════════════════════════════════════════════════════════════════════
// ID Validation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate that an ID does not contain the separator character ':'.
 *
 * @param id - The ID to validate
 * @param type - A description of the ID type for error messages
 * @throws Error if the ID contains ':'
 *
 * @example
 * ```ts
 * validateId('posts', 'tableId');        // OK
 * validateId('my:table', 'tableId');     // throws Error
 * ```
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
 * Construct a field key from table and field IDs.
 *
 * @param tableId - The table identifier
 * @param fieldId - The field identifier
 * @returns Key in format `{tableId}:{fieldId}`
 *
 * @example
 * ```ts
 * fieldKey('posts', 'title'); // 'posts:title'
 * ```
 */
export function fieldKey(tableId: string, fieldId: string): string {
	return `${tableId}:${fieldId}`;
}

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
 * Parse a field key into its component IDs.
 *
 * @param key - Key in format `{tableId}:{fieldId}`
 * @returns Object with tableId and fieldId
 * @throws Error if key format is invalid
 *
 * @example
 * ```ts
 * parseFieldKey('posts:title'); // { tableId: 'posts', fieldId: 'title' }
 * ```
 */
export function parseFieldKey(key: string): {
	tableId: string;
	fieldId: string;
} {
	const parts = key.split(':');
	if (parts.length !== 2) {
		throw new Error(
			`Invalid field key format: "${key}" (expected "tableId:fieldId")`,
		);
	}
	const [tableId, fieldId] = parts as [string, string];
	return { tableId, fieldId };
}

/**
 * Parse a row key into its component IDs.
 *
 * @param key - Key in format `{tableId}:{rowId}`
 * @returns Object with tableId and rowId
 * @throws Error if key format is invalid
 *
 * @example
 * ```ts
 * parseRowKey('posts:abc123'); // { tableId: 'posts', rowId: 'abc123' }
 * ```
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
 *
 * @example
 * ```ts
 * parseCellKey('posts:abc123:title'); // { tableId: 'posts', rowId: 'abc123', fieldId: 'title' }
 * ```
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
 *
 * @example
 * ```ts
 * tablePrefix('posts'); // 'posts:'
 * ```
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
 *
 * @example
 * ```ts
 * rowCellPrefix('posts', 'abc123'); // 'posts:abc123:'
 * ```
 */
export function rowCellPrefix(tableId: string, rowId: string): string {
	return `${tableId}:${rowId}:`;
}

/**
 * Check if a key starts with a given prefix.
 *
 * @param key - The key to check
 * @param prefix - The prefix to match
 * @returns true if key starts with prefix
 */
export function hasPrefix(key: string, prefix: string): boolean {
	return key.startsWith(prefix);
}

/**
 * Extract the ID portion after a prefix from a key.
 *
 * @param key - The full key
 * @param prefix - The prefix to remove
 * @returns The remaining portion of the key after the prefix
 *
 * @example
 * ```ts
 * extractAfterPrefix('posts:title', 'posts:'); // 'title'
 * ```
 */
export function extractAfterPrefix(key: string, prefix: string): string {
	if (!key.startsWith(prefix)) {
		throw new Error(`Key "${key}" does not start with prefix "${prefix}"`);
	}
	return key.slice(prefix.length);
}
