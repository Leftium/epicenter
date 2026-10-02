/**
 * Folder definitions: the shared declaration vocabulary, checked for what a
 * file folder can keep.
 *
 * A folder stores a row as one Markdown file. Its body is the file's text, so
 * a table that declares a body conversion is refused, never ignored.
 *
 * A field's editor hint decides nothing here. `field.reference` is a string
 * schema like any other: the folder checks no target, and renaming or
 * deleting a row repairs nothing that names it, so a stored identifier may
 * dangle.
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
	for (const [name, table] of compiled.data.tables) {
		if (table.body !== undefined)
			return Err({
				reason: `Table '${name}' declares a body codec. A file folder stores the body as Markdown text; remove the codec from this definition.`,
			});
	}
	return Ok(compiled.data);
}

/**
 * Declare a folder's identity and schema without opening anything. Tables are
 * written with `defineTable` and fields with `field`, the same vocabulary
 * every Epicenter storage declares with.
 *
 * The definition is checked here, where it is written: a malformed schema or
 * a body conversion throws at the declaration, not at the first open.
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
