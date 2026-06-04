/**
 * Inference: derive column kinds from frontmatter values.
 *
 * This is deliberately thin. The YAML parser already gives us the natural type
 * of a value (number / boolean / string / list); inference only refines
 * *strings* (is this string an ISO date? a URL?) and then takes a per-column
 * common type. It is the on-ramp to an explicit model, never the source of
 * truth.
 *
 * The kind lattice:
 *
 *   integer ⊂ number ⊂ string        (boolean, datetime, url are siblings that
 *                                      collapse to string when mixed)
 *
 * A column's kind is the narrowest kind every present value satisfies; a mix
 * that has no common numeric ancestor falls to `string`, the permissive floor.
 */

import type { ColumnKind, Row } from './types';

/** A value Matter inferred a kind for and the order it was first seen. */
export type InferredColumn = {
	/** The frontmatter key (also the column id and the default display label). */
	key: string;
	kind: ColumnKind;
	/** How many files carry a non-null value for this key (drives ordering). */
	count: number;
};

/** `YYYY-MM-DD` with an optional time/zone suffix. */
const ISO_DATE =
	/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function isUrl(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

export function isIsoDateString(value: unknown): boolean {
	return (
		typeof value === 'string' &&
		ISO_DATE.test(value) &&
		!Number.isNaN(Date.parse(value))
	);
}

/**
 * The kind a single value most specifically satisfies. Order matters: the most
 * specific kind wins, and `string` is the catch-all floor.
 */
export function inferValueKind(value: unknown): ColumnKind {
	if (typeof value === 'boolean') return 'boolean';
	if (typeof value === 'number') {
		return Number.isInteger(value) ? 'integer' : 'number';
	}
	if (isIsoDateString(value)) return 'datetime';
	if (isUrl(value)) return 'url';
	return 'string';
}

/**
 * The narrowest kind every present value in a column satisfies. Null/undefined
 * are ignored (a blank is not a type). An all-numeric mix widens to `number`;
 * any other mix falls to `string`.
 */
export function inferColumnKind(values: readonly unknown[]): ColumnKind {
	const present = values.filter((v) => v !== null && v !== undefined);
	if (present.length === 0) return 'string';

	const kinds = new Set(present.map(inferValueKind));
	if (kinds.size === 1) return [...kinds][0] as ColumnKind;
	if ([...kinds].every((k) => k === 'integer' || k === 'number')) return 'number';
	return 'string';
}

/**
 * Infer the columns of a folder from its rows' frontmatter. Deterministic: same
 * rows in, same columns out, ordered by frequency (most-present first) then by
 * first-seen, so the grid never jitters between opens.
 */
export function inferColumns(rows: readonly Row[]): InferredColumn[] {
	const valuesByKey = new Map<string, unknown[]>();
	const firstSeen: string[] = [];

	for (const row of rows) {
		for (const [key, value] of Object.entries(row.frontmatter)) {
			let bucket = valuesByKey.get(key);
			if (!bucket) {
				bucket = [];
				valuesByKey.set(key, bucket);
				firstSeen.push(key);
			}
			bucket.push(value);
		}
	}

	return firstSeen
		.map((key, index) => {
			const values = valuesByKey.get(key) ?? [];
			const count = values.filter((v) => v !== null && v !== undefined).length;
			return { column: { key, kind: inferColumnKind(values), count }, index };
		})
		.sort((a, b) => b.column.count - a.column.count || a.index - b.index)
		.map(({ column }) => column);
}
