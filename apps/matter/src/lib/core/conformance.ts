/**
 * Conformance: classify a folder's rows against its model.
 *
 * Modeled fields have row-completeness policy, so the per-cell split is FOUR states:
 *
 *   v == null ? (required ? NEEDS_VALUE : EMPTY) : check(v) ? OK : INVALID
 *
 * NEEDS_VALUE and EMPTY are the two empty states. Both cover an absent key OR an
 * explicit null; the nullish contract says a bare `title:` in YAML parses to null and
 * must mean the same as an omitted `title`. Required empty cells need attention.
 * Optional empty cells are valid. "Ready to publish" is "every cell is OK or EMPTY",
 * which is also "the row projects into the typed table".
 *
 * The validator is precompiled on the {@link Field} (built once at model load in
 * `validateModel`), so classification never recompiles; it reads `field.check`.
 *
 * Extras (frontmatter keys not in the model's fields) are orthogonal: collected for
 * the per-row expander, never affecting validity. A field whose shape was outside the
 * palette is not a modeled field, so its value also surfaces here as an extra.
 */

import type { Field } from '@epicenter/field';
import type { MatterField } from './model';
import type { Row } from './parse';

/**
 * A classified cell is one of four states, each a field applied to a row's value. The
 * state IS the verdict, so value-presence cannot disagree with it, and every member
 * carries its {@link Field} (a consumer reads `cell.field`, never an index into a
 * parallel array). {@link Cell} unions the four; a consumer composes the subset it
 * handles from these named members rather than subtracting from the union with
 * `Exclude`.
 */

// The field generic `F` is defaulted to the full {@link Field} union but left
// unconstrained: a per-kind widget pins it to one variant (`FieldOf<'select'>`), and
// TypeScript can't prove a generic `FieldOf<K>` is a subtype of the mapped-union `Field`,
// so an `extends Field` bound here would reject the registry's correlated map. `field: F`
// needs no bound; any non-field `F` is caught where the consumer reads `field.kind`.

/** A conformant cell of field `F`: the value passed its field's schema. */
export type OkCell<F = Field> = {
	field: F;
	state: 'OK';
	value: unknown;
};

/** An empty required cell of field `F`: the key is absent or null, so no value to carry. */
export type NeedsValueCell<F = Field> = {
	field: F;
	state: 'NEEDS_VALUE';
};

/** An empty optional cell of field `F`: absent or null, and valid by model policy. */
export type EmptyCell<F = Field> = {
	field: F;
	state: 'EMPTY';
};

/** A no-value cell: absent or explicit null, with policy deciding attention. */
export type NoValueCell<F = Field> = NeedsValueCell<F> | EmptyCell<F>;

/** A present value out of its field's domain: carries the `raw` value for the repair editor. */
export type InvalidCell<F = Field> = {
	field: F;
	state: 'INVALID';
	raw: unknown;
};

/** One classified cell: exactly one of the four states. */
export type Cell = OkCell | NeedsValueCell | EmptyCell | InvalidCell;

/** True for cells with no present value, whether required or optional. */
export function hasNoValue<F>(
	cell: OkCell<F> | NoValueCell<F> | InvalidCell<F>,
): cell is NoValueCell<F> {
	return cell.state === 'NEEDS_VALUE' || cell.state === 'EMPTY';
}

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
	/** True iff every cell is OK or EMPTY (the row projects into the typed table). */
	rowValid: boolean;
};

/**
 * Classify one cell. `value == null` is the nullish branch: an absent key and an
 * explicit `null` both arrive here, with requiredness deciding the verdict.
 */
function classifyCell(field: MatterField, value: unknown): Cell {
	if (value == null) {
		return field.required
			? { field, state: 'NEEDS_VALUE' }
			: { field, state: 'EMPTY' };
	}
	if (field.check(value)) return { field, state: 'OK', value };
	return { field, state: 'INVALID', raw: value };
}

/** Classify one row against the precompiled fields. */
export function classifyRow(
	fields: readonly MatterField[],
	row: Row,
): RowConformance {
	const cells = fields.map((field) =>
		classifyCell(field, row.frontmatter[field.name]),
	);

	const modeled = new Set(fields.map((f) => f.name));
	const extras: Extra[] = Object.entries(row.frontmatter)
		.filter(([key]) => !modeled.has(key))
		.map(([key, value]) => ({ key, value }));

	const rowValid = cells.every(
		(cell) => cell.state === 'OK' || cell.state === 'EMPTY',
	);

	return { row, cells, extras, rowValid };
}

/**
 * Classify a batch of rows against the precompiled fields. Compilation is the
 * expensive step (`Schema.Compile`), done once in `validateModel`; the fields are
 * threaded in here and never rebuilt per row or per file change.
 */
export function classifyRows(
	fields: readonly MatterField[],
	rows: readonly Row[],
): RowConformance[] {
	return rows.map((row) => classifyRow(fields, row));
}
