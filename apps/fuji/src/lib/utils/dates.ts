/**
 * Date parsing for Fuji's pipe-delimited DateTimeString format.
 *
 * DateTimeStrings are stored as `{iso}|{timezone}` (e.g.
 * `2025-01-15T10:30:00.000Z|America/Los_Angeles`). These helpers
 * extract the ISO portion for display formatting.
 */

/**
 * Parse a pipe-delimited DateTimeString into a Date object.
 *
 * Extracts the ISO portion before the `|` separator. If the string
 * has no separator, parses the whole string as a date.
 *
 * @example
 * ```typescript
 * const date = parseDateTime('2025-01-15T10:30:00.000Z|America/Los_Angeles');
 * // → Date('2025-01-15T10:30:00.000Z')
 * ```
 */
export function parseDateTime(dts: string): Date {
	return new Date(dts.split('|')[0]!);
}
