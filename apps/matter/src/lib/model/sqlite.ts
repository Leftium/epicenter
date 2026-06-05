/**
 * The SQLite projector: turn a folder's VALID rows into a typed table.
 *
 * `matter.sqlite` sits next to `matter.json` as a derived, disposable, READ-ONLY
 * mirror so a coding agent (or an in-app SQL console) can run arbitrary SQL over the
 * typed folder. The live in-app grid stays reactive JS over the projection; this is
 * the external read surface, not the app's query engine.
 *
 * This module is the PURE half: given the model and the classified rows, it produces
 * the `CREATE TABLE` DDL and the row tuples to insert. The impure half (writing the
 * file) is a thin Tauri command that executes the DDL and parameter-binds the rows;
 * keeping serialization here makes it unit-testable with no filesystem.
 *
 * Three properties define the table:
 *   - VALID rows only. "valid" means "projects into the typed table" (every modeled
 *     field present and passing its schema), so INVALID / unparseable files are
 *     absent by construction. Agents needing the broken rows read the markdown.
 *   - Every column NOT NULL. A valid row has every required field, so no column is
 *     ever null; nullability was deleted with optionality.
 *   - No CHECK. The projection inserts only already-validated rows, so a SQL CHECK
 *     would guard nothing; validation lives once, at classify time.
 */

import type { RowConformance } from './conformance';
import type { Column, MatterModel } from './model';
import { storageOf } from './palette';

/** A SQLite-bindable scalar. Valid rows never carry null, so this is string | number. */
export type SqlValue = string | number;

/**
 * The pure artifacts a Tauri command needs to materialize the table. All SQL TEXT
 * is built here (one quoting implementation); the command only executes the three
 * statements and parameter-binds each row, so it never constructs SQL.
 */
export type SqliteProjection = {
	/** The table name (the folder basename). */
	table: string;
	/** `DROP TABLE IF EXISTS ...` (the rebuild is full drop-and-recreate). */
	drop: string;
	/** `CREATE TABLE ...`: `path` PK, one NOT NULL column per field, `_extra` JSON. */
	ddl: string;
	/** `INSERT INTO ... VALUES (?, ?, ...)`: one `?` placeholder per column. */
	insert: string;
	/** Column names in insert order: `path`, the modeled fields, then `_extra`. */
	columns: string[];
	/** One tuple per VALID row, positional against {@link columns}. */
	rows: SqlValue[][];
};

/** Quote a SQL identifier, doubling embedded quotes, so any field name is safe. */
function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Serialize one validated cell value to its storage class. The value already passed
 * the column's schema (valid rows only), so the kind determines the encoding:
 * booleans to 0/1, lists to JSON text, everything else to its TEXT/INTEGER/REAL form.
 */
function serializeCell(column: Column, value: unknown): SqlValue {
	switch (column.kind) {
		case 'integer':
		case 'number':
			return value as number;
		case 'boolean':
			return value ? 1 : 0;
		case 'tags':
		case 'multiSelect':
			return JSON.stringify(value); // an array -> JSON TEXT
		case 'select':
			// A select value may be a string, number, or boolean (its enum's type).
			// The column is TEXT; store the string form (SQLite TEXT affinity coerces).
			return typeof value === 'string' ? value : String(value);
		default:
			// string / url / datetime: a plain string in a TEXT column.
			return String(value);
	}
}

/**
 * Build the `CREATE TABLE` for a folder: `path` primary key, one NOT NULL column per
 * modeled field (typed by its storage class), and an `_extra` JSON column for the
 * unmodeled keys, so an agent can see extras too.
 */
function buildDdl(table: string, columns: readonly Column[]): string {
	const defs = [
		`${quoteIdent('path')} TEXT PRIMARY KEY`,
		...columns.map(
			(c) => `${quoteIdent(c.name)} ${storageOf(c.kind)} NOT NULL`,
		),
		`${quoteIdent('_extra')} TEXT NOT NULL`,
	];
	return `CREATE TABLE ${quoteIdent(table)} (${defs.join(', ')})`;
}

/**
 * Project a classified folder into the SQLite artifacts. Only valid rows are
 * included; each row's modeled values are serialized per storage class and its
 * unmodeled keys are folded into the `_extra` JSON object.
 */
export function projectToSqlite(
	table: string,
	model: MatterModel,
	conformance: readonly RowConformance[],
): SqliteProjection {
	const columns = ['path', ...model.columns.map((c) => c.name), '_extra'];
	const rows = conformance
		.filter((c) => c.rowValid)
		.map((c) => {
			const cells = model.columns.map((col) =>
				serializeCell(col, c.row.frontmatter[col.name]),
			);
			const extra = JSON.stringify(
				Object.fromEntries(c.extras.map((e) => [e.key, e.value])),
			);
			return [c.row.name, ...cells, extra];
		});

	const placeholders = columns.map(() => '?').join(', ');
	const insert = `INSERT INTO ${quoteIdent(table)} (${columns
		.map(quoteIdent)
		.join(', ')}) VALUES (${placeholders})`;

	return {
		table,
		drop: `DROP TABLE IF EXISTS ${quoteIdent(table)}`,
		ddl: buildDdl(table, model.columns),
		insert,
		columns,
		rows,
	};
}
