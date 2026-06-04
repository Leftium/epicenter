/**
 * Inference: derive column kinds from frontmatter values.
 *
 * This is deliberately thin. The YAML parser already gives us the natural type
 * of a value (number / boolean / string / list); inference only refines
 * *strings* (is this string an ISO date-time? a URI?) and then takes a
 * per-column common type. It is the on-ramp to an explicit model, never the
 * source of truth.
 *
 * The kind lattice:
 *
 *   integer ⊂ number ⊂ string        (boolean, datetime, url are siblings that
 *                                      collapse to string when mixed)
 *
 * A column's kind is the narrowest kind every present value satisfies; a mix
 * that has no common numeric ancestor falls to `string`, the permissive floor.
 *
 * The on-ramp invariant (the one rule that keeps inference honest):
 *
 *   inferValueKind(v) === k  ⟹  Schema.Compile(SCHEMA_FOR[k]).Check(v) is true
 *
 * Increment 2 made this hold BY CONSTRUCTION: `inferValueKind` (in `schema.ts`)
 * asks the compiled `column.*` schema checks directly, so inference and
 * conformance share one definition of "what is a datetime / a url" and cannot
 * drift. Inference may UNDER-claim (fall to `string`); it can never over-claim a
 * kind whose schema would reject the value. A bare date is not a full RFC 3339
 * instant, so it falls to `string`, exactly as `column.dateTime` requires.
 */

import { inferValueKind } from './schema';
import type { ColumnKind, Row } from './types';

/** A column Matter inferred from a folder's frontmatter. */
export type InferredColumn = {
	/** The frontmatter key (also the column id and the default display label). */
	key: string;
	/** The scalar kind. For an array column this is the element kind. */
	kind: ColumnKind;
	/**
	 * True when every present value is a list (the `array` modifier). The element
	 * kind is in `kind`. A non-array object value has no scalar kind and falls back
	 * to `string` here; the renderer detects the object and uses the JSON cell.
	 */
	array: boolean;
	/** How many files carry a non-null value for this key (drives ordering). */
	count: number;
};

export { inferValueKind };

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
			const present = values.filter((v) => v !== null && v !== undefined);
			// An array column: every present value is a list. Infer the element kind
			// from the flattened elements; everything else infers as a scalar column.
			const array = present.length > 0 && present.every(Array.isArray);
			const kind = array
				? inferColumnKind((present as unknown[][]).flat())
				: inferColumnKind(present);
			return { column: { key, kind, array, count: present.length }, index };
		})
		.sort((a, b) => b.column.count - a.column.count || a.index - b.index)
		.map(({ column }) => column);
}
