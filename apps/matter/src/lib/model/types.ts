/**
 * The data shape the rest of the model is built on.
 *
 * A folder of markdown is read into a list of {@link Row}s (one per file). The
 * file's basename is the row identity: no id is minted, the name is the key
 * (flat, non-recursive folder, so a basename is unique). A relative path would
 * return here only if subfolders are ever supported.
 *
 * There is no `kind` vocabulary here: the model stores a plain JSON Schema per
 * field, and the UI kind is DERIVED from a schema's shape by `deriveKind` in
 * `schema.ts` (the one place "what is a url / a datetime" is defined). A folder
 * without a model is shown as raw text, never guessed into types.
 */

/** A markdown file read into memory. The file's basename is the row id. */
export type Row = {
	name: string;
	/** The parsed YAML frontmatter as a plain mapping. `{}` when the file has none. */
	frontmatter: Record<string, unknown>;
	/** The markdown body verbatim (the one rich field). Never AST-parsed in v1. */
	body: string;
};
