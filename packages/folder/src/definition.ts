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
	type DataDefinition,
	type DeclaredTable,
	prepareData,
	type ValidateFields,
} from '@epicenter/definition';
import { Err, Ok, type Result } from 'wellcrafted/result';

/** A table a folder can keep: declared with `defineTable`, with no body conversion. */
export type FolderTable = DeclaredTable & { readonly body?: undefined };

/**
 * Prepare a definition for file storage, or say why a folder cannot keep it.
 *
 * The result is the prepared definition: the declared shape, holding the
 * frozen schema snapshots a folder reads values through. Preparation is
 * memoized on the declaration and on its result, so an opener handed what
 * `defineFolder` returned gets it back and does no work twice.
 */
export function prepareFolderDefinition<TDefinition extends DataDefinition>(
	definition: TDefinition,
): Result<TDefinition, { readonly reason: string }> {
	const prepared = prepareData(definition);
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
 * Declare a folder's file interpretation and default dataset name without
 * opening anything. Tables use `defineTable` and fields use `field`, the same
 * vocabulary every Epicenter storage declares with.
 *
 * The definition is checked here, where it is written: a malformed schema or
 * a body conversion throws at the declaration, not at the first open. What
 * comes back has the declared shape and type, and is the prepared definition:
 * an owned, frozen snapshot of each schema.
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
	const declaration: Definition = {
		id,
		...(title === undefined ? {} : { title }),
		kv,
		tables,
	};
	const prepared = prepareFolderDefinition(declaration);
	if (prepared.error !== null) throw new Error(prepared.error.reason);
	return prepared.data;
}
