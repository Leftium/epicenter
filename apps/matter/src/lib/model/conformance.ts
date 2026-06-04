/**
 * Conformance: classify a folder's rows against its model.
 *
 * The app's one job: show how a folder conforms to its model, and let you fix
 * what doesn't. This module is the pure classifier. It compiles each field's
 * validator ONCE when the model loads, then checks every cell against the
 * precompiled validator (schemas are per COLUMN, not per cell).
 *
 * The per-cell three-way split the renderer needs:
 *
 *   v == null ? (nullable ? EMPTY : NEEDS_VALUE)   // absent key OR explicit null
 *             : check(v) ? OK : INVALID
 *
 * The `v == null` branch is NOT a smell: it is the genuine split between EMPTY
 * (a nullable field left blank, fine), NEEDS_VALUE (a required field left blank,
 * needs attention), and INVALID (a present value that fails its schema). TypeBox
 * cannot express "absent" for a bare value, so this nullish check lives outside
 * the compiled validator.
 *
 * This ADAPTS the wiki lens (match / missing / excess) with ONE deliberate
 * change: the lens distinguishes "missing" (absent key) from an explicit `null`;
 * Matter treats absent and `null` as the SAME empty, because a bare `title:` in
 * YAML parses to `null` and must mean the same as an omitted `title`. That
 * equivalence is a tested contract.
 *
 * Extras (frontmatter keys not in the model) are orthogonal: collected for the
 * per-row expander, NEVER affecting validity.
 */

import type { MatterModel } from './model';
import * as Schema from 'typebox/schema';
import type { Row } from './types';

/** The state of one cell against its field's schema. */
export type CellState = 'OK' | 'EMPTY' | 'NEEDS_VALUE' | 'INVALID';

/** A column's precompiled validator, built once per model load. */
export type CompiledColumn = {
	name: string;
	nullable: boolean;
	check: (value: unknown) => boolean;
};

/** One classified cell. */
export type CellResult = {
	name: string;
	value: unknown;
	state: CellState;
};

/** A frontmatter key the model does not declare. Never affects validity. */
export type Extra = {
	key: string;
	value: unknown;
};

/** A row classified against the model. */
export type RowConformance = {
	row: Row;
	cells: CellResult[];
	extras: Extra[];
	/** True iff every cell is OK or EMPTY (the row projects into the typed table). */
	rowValid: boolean;
};

/**
 * Compile each field's validator ONCE. Call on model load, not per row. The
 * stored schema IS the validator's input; there is no rebuild step.
 */
export function compileColumns(model: MatterModel): CompiledColumn[] {
	return model.fields.map((field) => {
		// `Validator.Check` reads `this`; keep the receiver by closing over the
		// validator instead of tearing the method off. `nullable` is already
		// derived from the schema's null branch at validate time; reuse it rather
		// than re-detecting the `anyOf`-null shape here.
		const validator = Schema.Compile(field.schema);
		return {
			name: field.name,
			nullable: field.derived.nullable,
			check: (value: unknown) => validator.Check(value),
		};
	});
}

/**
 * Classify one cell. `value == null` is the nullish branch: an absent key and an
 * explicit `null` both arrive here and split on whether the field is nullable.
 */
function classifyCell(column: CompiledColumn, value: unknown): CellState {
	if (value == null) return column.nullable ? 'EMPTY' : 'NEEDS_VALUE';
	return column.check(value) ? 'OK' : 'INVALID';
}

/** Classify one row against the precompiled columns. */
export function classifyRow(
	columns: readonly CompiledColumn[],
	row: Row,
): RowConformance {
	const cells = columns.map((column) => {
		const value = row.frontmatter[column.name];
		return { name: column.name, value, state: classifyCell(column, value) };
	});

	const modeled = new Set(columns.map((c) => c.name));
	const extras: Extra[] = Object.entries(row.frontmatter)
		.filter(([key]) => !modeled.has(key))
		.map(([key, value]) => ({ key, value }));

	const rowValid = cells.every(
		(cell) => cell.state === 'OK' || cell.state === 'EMPTY',
	);

	return { row, cells, extras, rowValid };
}

/**
 * Classify a batch of rows against ALREADY-compiled columns. Compilation is the
 * expensive step (`Schema.Compile` is codegen), so it is done once via
 * {@link compileColumns} when the model loads and the columns are threaded in
 * here, never rebuilt per row or per file change.
 */
export function classifyRows(
	columns: readonly CompiledColumn[],
	rows: readonly Row[],
): RowConformance[] {
	return rows.map((row) => classifyRow(columns, row));
}
