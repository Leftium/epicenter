/**
 * Rows as text: the one way a row file is read and the one way it is written.
 *
 * Both functions take a table of a prepared folder definition, the one
 * `defineFolder` returns, so they work before `openFolder` and with no
 * storage at all. A table's `get`, `list`, `create`, `replace`, and autosave
 * run exactly these; nothing else in the package parses or writes row text.
 *
 *     const definition = defineFolder({ kv: {}, tables: { todos } });
 *     const { data: row, error: issues } = parseRow(definition.tables.todos, text);
 *     const { data: saved } = formatRow(definition.tables.todos, row);
 *
 * `formatRow` writes one fixed text for a row: declared keys first in
 * declared order, then other keys, then the body byte for byte. Text that
 * `formatRow` writes always reads back through `parseRow` as the same row.
 */

import { type CreateRowOf, conformance } from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type CanonicalDocument,
	formatCanonicalDocument,
	parseRowSource,
} from './canonical.js';
import type { PreparedFolderTable } from './definition.js';

/**
 * The editable part of a row: every frontmatter field, unknown keys
 * included, and the Markdown body after the closing fence. A caller owns it,
 * so its top-level fields are assignable even where a definition's types are
 * readonly.
 */
export type Row<TFields> = {
	fields: { -readonly [K in keyof TFields]: TFields[K] };
	body: string;
};

/**
 * One reason text is not a valid row, located like a compiler diagnostic.
 * The message stands alone; neither its wording nor the number of issues is
 * a machine contract.
 */
export type RowIssue = {
	readonly message: string;
	/** The 1-based line in the whole text. Absent only for a declared field the text lacks. */
	readonly line?: number;
	/** The top-level frontmatter key involved, when there is one. */
	readonly field?: string;
};

/** Why text is not a valid row: never empty, in line order. */
export type RowIssues = readonly [RowIssue, ...RowIssue[]];

/**
 * Read text as a row of a prepared table: parse the complete frontmatter,
 * then check every declared field. Synchronous and pure, so it reads an
 * unsaved buffer as readily as a file.
 *
 * Text that has no canonical form fails with exactly one issue: the first
 * problem the parser met. Text that parses fails with one issue for each way
 * a declared field does not conform or is missing, at the line of the value
 * the validator names, or else of its key. Keys the table does not declare
 * are kept and never an issue.
 *
 * A valid row's values are this parse's own: mutable, shared with nothing,
 * and with unknown keys still on `fields`, so a caller can edit them and save
 * the complete row. Validation cannot change them: a field's callback is
 * shown a frozen copy.
 */
export function parseRow<const TTable extends PreparedFolderTable>(
	table: TTable,
	text: string,
): Result<Row<CreateRowOf<TTable>>, RowIssues> {
	const { data: parsed, error: refusal } = parseRowSource(text);
	if (refusal !== null)
		return Err(
			issueList([
				{ message: refusal.reason, line: refusal.line, field: refusal.field },
			]),
		);
	const { document, lineOf } = parsed;
	const { issues } = conformance(table.fields, document.fields);
	if (issues.length > 0)
		return Err(
			issueList(
				issues.map(({ field, path, message }) => ({
					message,
					line: lineOf(field, path),
					field,
				})),
			),
		);
	return Ok({
		fields: document.fields as Row<CreateRowOf<TTable>>['fields'],
		body: document.body,
	});
}

/**
 * The text a row is saved as. Refused, with one issue, when a value has no
 * exact form in a file: `NaN`, a `Date`, a class instance, a cycle, or a
 * lone surrogate. Fields are not checked against the schema, so a draft the
 * person is still typing formats as typed; `parseRow` of the text reports
 * whether it is a valid row.
 *
 * Only `fields` and `body` are read, once each, before this returns: later
 * changes to the row change nothing about the text.
 */
export function formatRow<const TTable extends PreparedFolderTable>(
	table: TTable,
	row: Row<CreateRowOf<TTable>>,
): Result<string, RowIssue> {
	const { data: text, error: refusal } = formatCanonicalDocument(
		row as unknown as CanonicalDocument,
		Object.keys(table.fields),
	);
	if (refusal === null) return Ok(text);
	return Err(
		Object.freeze(
			refusal.field === undefined
				? { message: `The row cannot be saved: ${refusal.reason}` }
				: {
						message: `${refusal.field} cannot be saved: ${refusal.reason}`,
						field: refusal.field,
					},
		),
	);
}

/** Frozen issues without absent keys, in line order; an issue with no line goes last. */
function issueList(
	issues: readonly { message: string; line?: number; field?: string }[],
): RowIssues {
	const located = issues.map(({ message, line, field }) =>
		Object.freeze({
			message,
			...(line === undefined ? {} : { line }),
			...(field === undefined ? {} : { field }),
		}),
	);
	located.sort(
		(a, b) =>
			(a.line ?? Number.POSITIVE_INFINITY) -
			(b.line ?? Number.POSITIVE_INFINITY),
	);
	return Object.freeze(located) as unknown as RowIssues;
}
