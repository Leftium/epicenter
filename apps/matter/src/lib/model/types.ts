/**
 * The data shapes the rest of the model is built on.
 *
 * A folder of markdown is read into a list of {@link Row}s (one per file). The
 * file path is the row identity: no id is minted, the path is the key.
 *
 * {@link ColumnKind} is the closed vocabulary of column types. It maps 1-1 to
 * the `column.*` helpers in `@epicenter/workspace` via the `KINDS` registry
 * (added in increment 2, where `buildColumnSchema` and the SQLite projection
 * arrive). Increment 1 only needs the vocabulary and the inference predicates,
 * so the registry's `build` / `cell` sides are deliberately absent here.
 */

/** A markdown file read into memory. The file path is the row id. */
export type Row = {
	path: string;
	/** The parsed YAML frontmatter as a plain mapping. `{}` when the file has none. */
	frontmatter: Record<string, unknown>;
	/** The markdown body verbatim (the one rich field). Never AST-parsed in v1. */
	body: string;
};

/**
 * The closed set of column kinds. Each maps 1-1 to a `column.*` helper:
 * `string -> column.string`, `integer -> column.integer`, `number ->
 * column.number`, `boolean -> column.boolean`, `datetime -> column.dateTime`,
 * `url -> column.url`, `enum -> column.enum`.
 *
 * `datetime` means a full RFC 3339 instant (what `column.dateTime` accepts). A
 * bare calendar date (`2026-06-04`), the most common frontmatter shape, is NOT a
 * `datetime`: `column.dateTime` would reject it, so inferring `datetime` there
 * would make "Create model from folder" invalidate its own rows. Bare dates
 * infer as `string` until a first-class `date` kind exists (a full slice:
 * `column.date` + cell + editor + classify), introduced when the calendar view
 * lands rather than as a half-member now.
 *
 * `enum` is never inferred (a set of strings infers as `string`); you opt into
 * it via the model, which harvests the column's distinct values.
 */
export type ColumnKind =
	| 'string'
	| 'integer'
	| 'number'
	| 'boolean'
	| 'datetime'
	| 'url'
	| 'enum';
