/**
 * Reddit CSV Parsing Morphs
 *
 * Reusable ArkType morphs for transforming CSV string data into normalized types.
 * These morphs handle the common patterns in Reddit GDPR exports:
 * - Empty strings → null
 * - Date strings → ISO strings (or null)
 * - Numeric strings → numbers
 */

import { type } from 'arktype';

// ═══════════════════════════════════════════════════════════════════════════════
// STANDALONE HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Reddit exports sometimes use 'registration ip' as a literal date value.
 * This needs to be treated as null.
 */
const REGISTRATION_IP_LITERAL = 'registration ip';

/** Convert empty string to null - standalone function for use outside ArkType */
export function emptyToNullFn(
	value: string | undefined | null,
): string | null {
	if (value === undefined || value === null || value === '') return null;
	return value;
}

/** Parse date string to ISO string - standalone function for use outside ArkType */
export function parseDateToIsoFn(
	dateStr: string | undefined | null,
): string | null {
	if (!dateStr || dateStr === '' || dateStr === REGISTRATION_IP_LITERAL)
		return null;
	try {
		const date = new Date(dateStr);
		if (Number.isNaN(date.getTime())) return null;
		return date.toISOString();
	} catch {
		return null;
	}
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRING MORPHS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Empty string → null, otherwise keep string.
 * Useful for fields that may be empty in CSVs.
 */
export const emptyToNull = type('string').pipe((s): string | null =>
	emptyToNullFn(s),
);

/**
 * Trim whitespace and convert empty string → null.
 */
export const trimToNull = type('string').pipe((s): string | null => {
	const trimmed = s.trim();
	return trimmed === '' ? null : trimmed;
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATE MORPHS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse date string → ISO string.
 * Returns null for empty strings, invalid dates, or special values like 'registration ip'.
 */
export const dateToIso = type('string').pipe((s): string | null =>
	parseDateToIsoFn(s),
);

/**
 * Parse optional date string → ISO string.
 * Handles undefined input (for optional CSV fields).
 */
export const optionalDateToIso = type('string | undefined').pipe(
	(s): string | null => parseDateToIsoFn(s),
);

/**
 * Parse date string → Date object.
 * Useful if you want actual Date objects instead of ISO strings.
 */
export const dateToDate = type('string').pipe((s): Date | null => {
	if (!s || s === '' || s === REGISTRATION_IP_LITERAL) return null;
	try {
		const date = new Date(s);
		if (Number.isNaN(date.getTime())) return null;
		return date;
	} catch {
		return null;
	}
});

// ═══════════════════════════════════════════════════════════════════════════════
// NUMERIC MORPHS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Parse numeric string → number.
 * Uses ArkType's built-in numeric parsing.
 */
export const numericParse = type('string.numeric.parse');

/**
 * Parse integer string → number.
 * Uses ArkType's built-in integer parsing.
 */
export const integerParse = type('string.integer.parse');

/**
 * Parse numeric string or empty → number or null.
 */
export const numericOrNull = type('string').pipe((s): number | null => {
	if (s === '') return null;
	const n = Number(s);
	return Number.isNaN(n) ? null : n;
});

// ═══════════════════════════════════════════════════════════════════════════════
// COMPOSITE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Vote direction enum.
 */
export const voteDirection = type("'up' | 'down' | 'none' | 'removed'");

// ═══════════════════════════════════════════════════════════════════════════════
// TYPE EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export type EmptyToNull = typeof emptyToNull.infer;
export type DateToIso = typeof dateToIso.infer;
export type NumericParse = typeof numericParse.infer;
export type VoteDirection = typeof voteDirection.infer;
