/**
 * Row text without a folder: read it as a row, interpret it, or write draft
 * values as it.
 *
 * Each function takes a table of a prepared folder definition, the one
 * `defineFolder` returns, so they work before `openFolder` and with no
 * storage at all. `PreparedFolderTable` marks that table in types only. Neither reads a file, hashes, or invents a snapshot or a
 * capture: they describe text, not a file.
 *
 *     const definition = defineFolder({ kv: {}, tables: { todos } });
 *     const { data: text } = serializeRow(definition.tables.todos, { fields, body });
 *     const reading = inspectRow(definition.tables.todos, text);
 *     const { data: row, error: issues } = parseRow(definition.tables.todos, text);
 *
 * `serializeRow` writes the declared values it is given, so it never
 * reproduces an existing file: a field that did not conform and every key the
 * table does not declare are absent from a reading. Change an existing row
 * with `table.update`, `patchRowText`, or `table.replace` of edited text.
 */

import {
	type CreateRowOf,
	conformance,
	type FieldMap,
	isJsonSafe,
} from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { parseRowSource } from './canonical.js';
import { submittedText } from './capture.js';
import type { PreparedFolderTable } from './definition.js';
import { TableError } from './errors.js';
import { composeSource, parseSource, valueProblem } from './markdown.js';
import {
	type DeepReadonly,
	type FieldIssue,
	freezeDeep,
	freezeIssues,
	type ParseError,
} from './reading.js';

/**
 * How row text reads. Text that does not parse has a `parseError`, no
 * fields, no body, and no issues. Text that parses has a body and every
 * declared field that validated by itself, so one field's issue does not
 * hide another field's value.
 *
 * `fields` is always partial: an empty `issues` does not make it a complete
 * row, so check the fields an action needs. Every declared field the text
 * lacks is an issue. Keys the table does not declare stay in the text and
 * are not issues.
 */
export type TableReading<TFields> = {
	readonly fields: DeepReadonly<Partial<TFields>>;
	/** The text after the closing fence, possibly empty; `undefined` when the text does not parse. */
	readonly body: string | undefined;
	readonly parseError: ParseError | undefined;
	readonly issues: readonly FieldIssue[];
};

/**
 * Draft values for one row: declared keys, any value. A value need not
 * conform, so a form can preview what a person is still typing; `undefined`
 * leaves the key out.
 */
export type RowDraft<TFields> = {
	readonly fields: { readonly [K in keyof TFields & string]?: unknown };
	readonly body?: string;
};

/**
 * Interpret row text against a table's prepared fields. Parsing comes first
 * and fails as a whole. The shared conformance read then checks each declared
 * field by itself; nothing is coerced, defaulted, or repaired.
 *
 * The values are this parse's own, so freezing them at every depth touches
 * nothing a caller holds. Each declared value that is JSON is frozen before
 * its field checks it, so a field's callback cannot make a reading say what
 * its text does not.
 *
 * YAML can also hold what JSON cannot: a `!!binary` byte array, a date, a
 * set, a map, a number that is not finite. A declared value like that is
 * handed over as it is, since a byte array cannot be frozen: the conformance
 * read refuses it as an issue before any callback runs. A key the table does
 * not declare is never checked, so nothing here touches its value.
 */
export function readRowText<TFields>(
	schemas: FieldMap,
	text: string,
): TableReading<TFields> {
	const { data: parsed, error: parseError } = parseSource(text);
	if (parseError !== null)
		return Object.freeze({
			fields: Object.freeze({}) as DeepReadonly<Partial<TFields>>,
			body: undefined,
			parseError,
			issues: freezeIssues([]),
		});
	return conformRowValues(schemas, parsed.values, parsed.body);
}

/**
 * The reading of frontmatter values a parser already produced: each declared
 * field checked by itself through the shared conformance read. The values
 * must be the parse's own; each declared value that is JSON is frozen before
 * its field checks it. `readRowText` reads its own parse this way, and a row
 * editor reads the complete canonical parse it exposes, so the fields judged
 * valid are the fields shown.
 */
export function conformRowValues<TFields>(
	schemas: FieldMap,
	values: Readonly<Record<string, unknown>>,
	body: string,
): TableReading<TFields> {
	const declared: Record<string, unknown> = {};
	for (const key of Object.keys(schemas)) {
		if (!Object.hasOwn(values, key)) continue;
		const value = values[key];
		declared[key] = isJsonSafe(value) ? freezeDeep(value) : value;
	}
	const { conforming, issues } = conformance(schemas, declared);
	return Object.freeze({
		// Every value is frozen already; only the map that holds them is new.
		fields: Object.freeze(conforming) as DeepReadonly<Partial<TFields>>,
		body,
		parseError: undefined,
		issues: freezeIssues(issues),
	});
}

/**
 * Why values cannot be written as frontmatter that reads back as supplied.
 * A schema decides nothing here.
 */
export function unrepresentable(
	values: Readonly<Record<string, unknown>>,
): FieldIssue[] {
	const issues: FieldIssue[] = [];
	for (const [key, value] of Object.entries(values)) {
		const problem = valueProblem(value);
		if (problem !== undefined)
			issues.push({
				field: key,
				message: `${key} cannot be saved: ${problem}`,
			});
	}
	return issues;
}

/**
 * Complete row text for values: both fences around the declared keys present,
 * in declared order, then the body. The text is that of its UTF-8 bytes, so
 * an unpaired surrogate is already U+FFFD, exactly as a save would submit it.
 * `create` and `serializeRow` both write rows through this; only `create`
 * checks the values against the schema first.
 */
export function composeRowText(
	schemas: FieldMap,
	values: Readonly<Record<string, unknown>>,
	body: string,
): Result<string, Extract<TableError, { name: 'InvalidValues' }>> {
	const ordered: Record<string, unknown> = Object.create(null);
	for (const key of Object.keys(schemas))
		if (Object.hasOwn(values, key)) ordered[key] = values[key];
	const { data: text, error: composeError } = composeSource(ordered, body);
	if (composeError !== null)
		return TableError.InvalidValues({
			issues: [
				{
					field: composeError.field,
					message: `${composeError.field} cannot be saved: ${composeError.reason}`,
				},
			],
		});
	return Ok(submittedText(text).text);
}

/**
 * Interpret row text with a table of a prepared definition: parse it once,
 * then check each declared field by itself. Synchronous and pure: it reads no
 * file and invents no capture, so it reads an unsaved buffer, a receipt's
 * `text`, or a draft before any folder is open.
 *
 * `table` comes from the definition `defineFolder` returned; its type says
 * so, and a raw `defineTable` declaration does not compile here. The type is
 * not a proof of identity: a table rebuilt with replaced or cloned fields
 * still compiles, and reading a declared value through such a field throws,
 * as every read of an unprepared schema does. Prepare it again instead.
 */
export function inspectRow<const TTable extends PreparedFolderTable>(
	table: TTable,
	text: string,
): TableReading<CreateRowOf<TTable>> {
	return readRowText(table.fields, text);
}

/**
 * Preview the text `create` would write for draft values, before any folder
 * is open. Values are not checked against the schema: one that does not
 * conform is written all the same, and `inspectRow` of the result reports
 * it, as it reports each declared field the draft leaves out. A value YAML
 * cannot hold as supplied, such as `NaN` or a `Date`, and a key the table
 * does not declare are `InvalidValues`, since no row could be saved with
 * them. `create` writes the same text for the same values once they conform.
 *
 * Like `inspectRow`, it takes a table `defineFolder` prepared, so the
 * preview reads back through the same schemas. It checks no value itself, so
 * a rebuilt table that `inspectRow` would refuse is not noticed here.
 *
 * It writes only what it is given. Never pass it an existing row's reading
 * to rewrite that file: the reading lacks unknown keys and fields that did
 * not conform, so the text would lose them.
 */
export function serializeRow<const TTable extends PreparedFolderTable>(
	table: TTable,
	draft: RowDraft<CreateRowOf<TTable>>,
): Result<string, Extract<TableError, { name: 'InvalidValues' }>> {
	const supplied: Record<string, unknown> = Object.create(null);
	const issues: FieldIssue[] = [];
	for (const [key, value] of Object.entries(draft.fields ?? {})) {
		if (value === undefined) continue;
		if (!Object.hasOwn(table.fields, key))
			issues.push({ field: key, message: `${key} is not declared` });
		else supplied[key] = value;
	}
	issues.push(...unrepresentable(supplied));
	if (issues.length > 0) return TableError.InvalidValues({ issues });
	return composeRowText(table.fields, supplied, draft.body ?? '');
}

/**
 * The editable part of a row: every frontmatter field, unknown keys
 * included, and the Markdown body after the closing fence.
 */
export type Row<TFields> = {
	fields: TFields;
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

/** Why text is not a valid row: never empty. */
export type RowIssues = readonly [RowIssue, ...RowIssue[]];

/**
 * Read text as a row of a prepared table: parse the complete frontmatter,
 * then check every declared field. Synchronous and pure, so it reads an
 * unsaved buffer as readily as a file.
 *
 * Text that has no canonical form fails with exactly one issue: the first
 * problem the parser met. Text that parses fails with one issue for each way
 * a declared field does not conform or is missing, each at the line of its
 * key. Keys the table does not declare are kept and never an issue.
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
			Object.freeze([
				Object.freeze({
					message: refusal.reason,
					...(refusal.line === undefined ? {} : { line: refusal.line }),
					...(refusal.field === undefined ? {} : { field: refusal.field }),
				}),
			]) as RowIssues,
		);
	const { document, keyLine } = parsed;
	const { issues } = conformance(table.fields, document.fields);
	if (issues.length > 0)
		return Err(
			Object.freeze(
				issues.map(({ field, message }) => {
					const line = keyLine(field);
					return Object.freeze(
						line === undefined ? { message, field } : { message, line, field },
					);
				}),
			) as RowIssues,
		);
	return Ok({
		fields: document.fields as CreateRowOf<TTable>,
		body: document.body,
	});
}
