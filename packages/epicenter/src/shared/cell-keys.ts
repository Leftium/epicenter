/**
 * Cell key primitives for compound key encoding.
 *
 * Encodes (rowId, columnId) pairs as colon-separated strings.
 * - rowId MUST NOT contain ':' (validated, throws on violation)
 * - columnId MAY contain ':' (split on first colon only)
 *
 * @module
 */

/** The separator character used in compound cell keys. */
export const KEY_SEPARATOR = ':' as const;

/** Compose a cell key from rowId and columnId. Throws if rowId contains ':'. */
export function cellKey(rowId: string, columnId: string): string {
	if (rowId.includes(KEY_SEPARATOR)) {
		throw new Error(`rowId cannot contain '${KEY_SEPARATOR}': "${rowId}"`);
	}
	return `${rowId}${KEY_SEPARATOR}${columnId}`;
}

/** Parse a cell key into rowId and columnId. Splits on first ':' only. */
export function parseCellKey(key: string): { rowId: string; columnId: string } {
	const idx = key.indexOf(KEY_SEPARATOR);
	if (idx === -1) throw new Error(`Invalid cell key: "${key}"`);
	return { rowId: key.slice(0, idx), columnId: key.slice(idx + 1) };
}

/** Create a row prefix for scanning all cells in a row. Throws if rowId contains ':'. */
export function rowPrefix(rowId: string): string {
	if (rowId.includes(KEY_SEPARATOR)) {
		throw new Error(`rowId cannot contain '${KEY_SEPARATOR}': "${rowId}"`);
	}
	return `${rowId}${KEY_SEPARATOR}`;
}

/** Extract rowId from a cell key. Faster than parseCellKey when columnId isn't needed. */
export function extractRowId(key: string): string {
	const idx = key.indexOf(KEY_SEPARATOR);
	if (idx === -1) throw new Error(`Invalid cell key: "${key}"`);
	return key.slice(0, idx);
}
