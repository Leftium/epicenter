/**
 * The three-way merge of one row file by field and body (ADR-0514).
 *
 * Every version is read through `parseRow` against its table, so the merge
 * compares the values a table reads, never their spelling: key order,
 * quoting, and comments in frontmatter never conflict. For each field, equal
 * values agree and a side unchanged from the base yields to the other.
 * Values compare as JSON, so object key order does not matter and arrays and
 * objects are one unit each. The body merges by line with `mergeLines`.
 *
 * The caller writes a merged row with `formatRow`, so merged text is the
 * standard form. A version that is absent or does not read as a row cannot
 * be merged by field: the whole file is one unit for a person to settle.
 *
 * This module writes nothing and loads no Git implementation.
 */
import type { PreparedFolderTable } from './definition.js';
import { mergeLines } from './git/merge-lines.js';
import { parseRow, type Row } from './row-text.js';

/** A row with no schema type: what a merge reads and writes. */
export type AnyRow = Row<Record<string, unknown>>;

/** A row file's text at the merge base and on each side, `null` for no file. */
export type RowVersions = {
	readonly base: string | null;
	readonly ours: string | null;
	readonly theirs: string | null;
};

/** One field both sides changed differently. `undefined` is no such field. */
export type FieldConflict = {
	readonly field: string;
	readonly base: unknown;
	readonly ours: unknown;
	readonly theirs: unknown;
};

/** Body lines both sides changed differently. `base` is `undefined` with no base row. */
export type BodyConflict = {
	readonly base: string | undefined;
	readonly ours: string;
	readonly theirs: string;
};

export type RowMerge =
	| { readonly kind: 'merged'; readonly row: AnyRow }
	/**
	 * `row` holds every field that merged and leaves out every conflicted one;
	 * its body is the merged body, or ours while the body conflicts.
	 */
	| {
			readonly kind: 'conflict';
			readonly row: AnyRow;
			readonly fields: readonly FieldConflict[];
			readonly body: BodyConflict | undefined;
	  }
	/** A side has no file, or a version does not read as a row of the table. */
	| { readonly kind: 'whole' };

/** Whether two JSON values are the same value, whatever their key order. */
export function sameValue(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		left === null ||
		right === null
	)
		return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return false;
		return (
			left.length === right.length &&
			left.every((item, index) => sameValue(item, right[index]))
		);
	}
	const leftKeys = Object.keys(left);
	const rightRecord = right as Record<string, unknown>;
	return (
		leftKeys.length === Object.keys(right).length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(right, key) &&
				sameValue((left as Record<string, unknown>)[key], rightRecord[key]),
		)
	);
}

/** One version as a row, `null` for no file, `undefined` for text that is not a row. */
function read(
	table: PreparedFolderTable,
	text: string | null,
): AnyRow | null | undefined {
	if (text === null) return null;
	const { data, error } = parseRow(table, text);
	return error === null ? (data as AnyRow) : undefined;
}

/** Equal values agree; a side unchanged from the base yields. */
function choose<T>(
	base: T,
	ours: T,
	theirs: T,
	same: (left: T, right: T) => boolean,
): { readonly value: T } | undefined {
	if (same(ours, theirs) || same(theirs, base)) return { value: ours };
	if (same(ours, base)) return { value: theirs };
	return undefined;
}

/**
 * Merge three versions of a row of `table`. Two added rows with no base
 * merge over an empty one, so only what both added alike agrees.
 */
export async function mergeRow(
	table: PreparedFolderTable,
	versions: RowVersions,
): Promise<RowMerge> {
	const base = read(table, versions.base);
	const ours = read(table, versions.ours);
	const theirs = read(table, versions.theirs);
	if (
		base === undefined ||
		ours === undefined ||
		ours === null ||
		theirs === undefined ||
		theirs === null
	)
		return { kind: 'whole' };

	const fields: Record<string, unknown> = {};
	const conflicts: FieldConflict[] = [];
	const names = new Set([
		...Object.keys(base?.fields ?? {}),
		...Object.keys(ours.fields),
		...Object.keys(theirs.fields),
	]);
	const at = (row: AnyRow | null, name: string) =>
		row !== null && Object.hasOwn(row.fields, name)
			? row.fields[name]
			: undefined;
	for (const name of names) {
		const [b, o, t] = [at(base, name), at(ours, name), at(theirs, name)];
		const chosen = choose(b, o, t, sameValue);
		if (chosen === undefined) {
			conflicts.push({ field: name, base: b, ours: o, theirs: t });
			continue;
		}
		if (chosen.value !== undefined)
			Object.defineProperty(fields, name, {
				value: chosen.value,
				enumerable: true,
				writable: true,
				configurable: true,
			});
	}

	const bodies = {
		base: base?.body ?? '',
		ours: ours.body,
		theirs: theirs.body,
	};
	const body =
		choose(bodies.base, bodies.ours, bodies.theirs, Object.is)?.value ??
		(await mergeLines(bodies));
	const row = { fields, body: body ?? ours.body };
	if (conflicts.length === 0 && body !== undefined)
		return { kind: 'merged', row };
	return {
		kind: 'conflict',
		row,
		fields: conflicts,
		body:
			body === undefined
				? { base: base?.body, ours: ours.body, theirs: theirs.body }
				: undefined,
	};
}
