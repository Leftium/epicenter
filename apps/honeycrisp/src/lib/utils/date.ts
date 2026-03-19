/**
 * Parse a workspace datetime string into a native Date.
 *
 * Workspace stores timestamps as `"YYYY-MM-DDTHH:mm:ss|counter"` — the
 * pipe-delimited counter is a Lamport clock for CRDT ordering and must
 * be stripped before parsing.
 *
 * @example
 * ```typescript
 * import { parseDateTime } from '$lib/utils/date';
 *
 * const date = parseDateTime(note.updatedAt);
 * format(date, 'h:mm a'); // "3:42 PM"
 * ```
 */
export function parseDateTime(dts: string): Date {
	return new Date(dts.split('|')[0]!);
}

import { differenceInDays, format, isToday, isYesterday } from 'date-fns';

/**
 * Get a human-readable date group label for note list grouping.
 *
 * Returns labels like "Today", "Yesterday", "Previous 7 Days",
 * "Previous 30 Days", or a month/year string for older dates.
 *
 * @example
 * ```typescript
 * import { getDateLabel } from '$lib/utils/date';
 *
 * const label = getDateLabel(note.updatedAt);
 * // "Today" | "Yesterday" | "Previous 7 Days" | "March 2026"
 * ```
 */
export function getDateLabel(dts: string): string {
	const date = parseDateTime(dts);
	if (isToday(date)) return 'Today';
	if (isYesterday(date)) return 'Yesterday';
	const daysAgo = differenceInDays(new Date(), date);
	if (daysAgo <= 7) return 'Previous 7 Days';
	if (daysAgo <= 30) return 'Previous 30 Days';
	return format(date, 'MMMM yyyy');
}
