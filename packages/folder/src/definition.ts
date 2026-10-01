/**
 * Folder definitions: the shared declaration vocabulary, checked for what a
 * file folder can keep.
 *
 * A folder stores a row as one Markdown file. Its body is the file's text, so
 * a table that declares a body conversion is refused, and so is a reference
 * field, because renaming a row file would not repair what points at it.
 * Unsupported declarations are refused, never ignored.
 */
import {
	compileData,
	type DataDefinition,
	type DeclaredTable,
	type ParsedDataDefinition,
	type ValidateFields,
} from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';

/** A table a folder can keep: declared with `defineTable`, with no body conversion. */
export type FolderTable = DeclaredTable & { readonly body?: undefined };

/**
 * Compile a definition for file storage, or say why a folder cannot keep it.
 * Compilation is memoized on the definition object, so an opener that
 * compiles a definition `defineFolder` already checked does no work twice.
 */
export function compileFolderDefinition(
	definition: DataDefinition,
): Result<ParsedDataDefinition, { readonly reason: string }> {
	const compiled = compileData(definition);
	if (compiled.error !== null) return Err({ reason: compiled.error.message });
	for (const [name, table] of [
		...compiled.data.tables,
		['kv', compiled.data.kv] as const,
	]) {
		if (table.body !== undefined)
			return Err({
				reason: `Table '${name}' declares a body codec. A file folder stores the body as Markdown text; remove the codec from this definition.`,
			});
		for (const [field, declared] of table.fields)
			if (declared.reference !== null)
				return Err({
					reason: `Field '${name}.${field}' is a reference to '${declared.reference}'. File folders do not support reference fields yet: renaming a row would not repair them.`,
				});
	}
	return Ok(compiled.data);
}

/**
 * Declare a folder's identity and schema without opening anything. Tables are
 * written with `defineTable` and fields with `field`, the same vocabulary
 * every Epicenter storage declares with.
 *
 * The definition is checked here, where it is written: a malformed schema, a
 * body conversion, or a reference field throws at the declaration, not at the
 * first open.
 */
export function defineFolder<const TDefinition extends DataDefinition>(
	schema: TDefinition & {
		kv: ValidateFields<TDefinition['kv']>;
		tables: {
			[Name in keyof TDefinition['tables']]: TDefinition['tables'][Name] extends FolderTable
				? TDefinition['tables'][Name]
				: FolderTable;
		};
	} & Record<Exclude<keyof TDefinition, keyof DataDefinition>, never>,
) {
	type Definition = Pick<
		TDefinition & Pick<DataDefinition, 'title'>,
		'id' | 'title' | 'kv' | 'tables'
	>;
	const { id, title, kv, tables } = schema;
	const declaration: Definition = Object.freeze({
		id,
		...(title === undefined ? {} : { title }),
		kv,
		tables,
	});
	const compiled = compileFolderDefinition(declaration);
	if (compiled.error !== null) throw new Error(compiled.error.reason);
	return declaration;
}
