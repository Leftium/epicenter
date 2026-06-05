/**
 * Conformance: classify a folder's rows against its model.
 *
 * Every modeled field is required, so the per-cell split is THREE states:
 *
 *   v == null ? NEEDS_VALUE : check(v) ? OK : INVALID
 *
 * NEEDS_VALUE is the only empty state (an absent key OR an explicit null; the nullish
 * contract: a bare `title:` in YAML parses to null and must mean the same as an
 * omitted `title`). There is no EMPTY: a blank required field always needs attention.
 * "Ready to publish" is "every cell OK", which is also "the row projects into the
 * typed table".
 *
 * The validator is precompiled on the {@link Field} (built once at model load in
 * `validateModel`), so classification never recompiles; it reads `field.check`.
 *
 * Extras (frontmatter keys not in the model's fields) are orthogonal: collected for
 * the per-row expander, never affecting validity. A field whose shape was outside the
 * palette is not a modeled field, so its value also surfaces here as an extra.
 */

import type { Field } from './model';
import type { Row } from './types';

/**
 * One classified cell: a field applied to a row's value. The variant IS the verdict,
 * so value-presence cannot disagree with state. `OK` carries the conformant `value`;
 * `NEEDS_VALUE` carries nothing (the field is empty); `INVALID` carries the
 * out-of-domain `raw`, which only the repair editor reads. Every variant carries its
 * {@link Field}, so a consumer reads `cell.field` instead of zipping a parallel field
 * array by index.
 */
export type Cell =
	| { field: Field; state: 'OK'; value: unknown }
	| { field: Field; state: 'NEEDS_VALUE' }
	| { field: Field; state: 'INVALID'; raw: unknown };

/** A frontmatter key the model does not declare. Never affects validity. */
export type Extra = {
	key: string;
	value: unknown;
};

/** A row classified against the model. */
export type RowConformance = {
	row: Row;
	cells: Cell[];
	extras: Extra[];
	/** True iff every cell is OK (the row projects into the typed table). */
	rowValid: boolean;
};

/**
 * Classify one cell. `value == null` is the nullish branch: an absent key and an
 * explicit `null` both arrive here, and (everything required) both need a value.
 */
function classifyCell(field: Field, value: unknown): Cell {
	if (value == null) return { field, state: 'NEEDS_VALUE' };
	if (field.check(value)) return { field, state: 'OK', value };
	return { field, state: 'INVALID', raw: value };
}

/** Classify one row against the precompiled fields. */
export function classifyRow(
	fields: readonly Field[],
	row: Row,
): RowConformance {
	const cells = fields.map((field) =>
		classifyCell(field, row.frontmatter[field.name]),
	);

	const modeled = new Set(fields.map((f) => f.name));
	const extras: Extra[] = Object.entries(row.frontmatter)
		.filter(([key]) => !modeled.has(key))
		.map(([key, value]) => ({ key, value }));

	const rowValid = cells.every((cell) => cell.state === 'OK');

	return { row, cells, extras, rowValid };
}

/**
 * Classify a batch of rows against the precompiled fields. Compilation is the
 * expensive step (`Schema.Compile`), done once in `validateModel`; the fields are
 * threaded in here and never rebuilt per row or per file change.
 */
export function classifyRows(
	fields: readonly Field[],
	rows: readonly Row[],
): RowConformance[] {
	return rows.map((row) => classifyRow(fields, row));
}
