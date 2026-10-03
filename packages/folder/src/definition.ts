/**
 * Folder definitions: the shared declaration vocabulary, checked for what a
 * file folder can keep.
 *
 * A folder definition is how a tool reads and edits a folder's files. It names
 * no dataset: the opener is given the folder's ID, so one definition can read
 * several folders and several definitions can read one.
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
	type DataSchema,
	type DeclaredTable,
	prepareSchema,
	type ValidateFields,
} from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';

/** A table a folder can keep: declared with `defineTable`, with no body conversion. */
export type FolderTable = DeclaredTable & { readonly body?: undefined };

/** What a folder reads its files through: a schema that names no dataset. */
export type FolderDefinition = DataSchema & { readonly id?: never };

/**
 * Prepare a definition for file storage, or say why a folder cannot keep it.
 *
 * The result is the prepared definition: the declared shape, holding the
 * frozen schema snapshots a folder reads values through. Preparation is
 * memoized on the declaration and on its result, so an opener handed what
 * `defineFolder` returned gets it back and does no work twice. A definition
 * with an `id`, which only an untyped caller can hand in, is refused.
 */
export function prepareFolderDefinition<TDefinition extends FolderDefinition>(
	definition: TDefinition,
): Result<TDefinition, { readonly reason: string }> {
	const prepared = prepareSchema(definition);
	if (prepared.error !== null) return Err({ reason: prepared.error.message });
	for (const [name, table] of Object.entries(prepared.data.tables)) {
		if (table.body !== undefined)
			return Err({
				reason: `Table '${name}' declares a body codec. A file folder stores the body as Markdown text; remove the codec from this definition.`,
			});
	}
	return Ok(prepared.data);
}

/**
 * Declare how a folder's files read without opening anything or naming a
 * folder. Tables use `defineTable` and fields use `field`, the same
 * vocabulary every Epicenter storage declares with.
 *
 * The definition is checked here, where it is written: a malformed schema, a
 * body conversion, or an `id` throws at the declaration, not at the first
 * open. What comes back has the declared shape and type, and is the prepared
 * definition: an owned, frozen snapshot of each schema.
 */
export function defineFolder<const TDefinition extends DataSchema>(
	schema: TDefinition & {
		kv: ValidateFields<TDefinition['kv']>;
		tables: {
			[Name in keyof TDefinition['tables']]: TDefinition['tables'][Name] extends FolderTable
				? TDefinition['tables'][Name]
				: FolderTable;
		};
	} & Record<Exclude<keyof TDefinition, keyof DataSchema>, never>,
) {
	type Definition = Pick<
		TDefinition & Pick<DataSchema, 'title'>,
		'title' | 'kv' | 'tables'
	>;
	if (Object.hasOwn(schema, 'id'))
		throw new Error(
			'A folder definition names no folder. Pass the folder ID to openFolder instead.',
		);
	const { title, kv, tables } = schema;
	const declaration: Definition = {
		...(title === undefined ? {} : { title }),
		kv,
		tables,
	};
	const prepared = prepareFolderDefinition(declaration);
	if (prepared.error !== null) throw new Error(prepared.error.reason);
	return prepared.data;
}
