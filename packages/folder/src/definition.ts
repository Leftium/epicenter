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

/**
 * Declared and never assigned: the mark exists only in types, so a prepared
 * table is the same plain object at runtime.
 */
declare const PREPARED: unique symbol;

/**
 * A table of a definition `defineFolder` prepared: what `parseRow` and
 * `formatRow` take. Only `defineFolder`'s return type carries the mark, so
 * a raw `defineTable` declaration handed to either is a compile error rather
 * than a call that works until a declared value appears.
 *
 * The mark is a type, not a proof. It survives a spread, so an object built
 * from a prepared table with replaced or cloned `fields` still type-checks,
 * and reading a value through such a field throws, as every read of an
 * unprepared schema does. Keep the prepared objects as `defineFolder` returned
 * them; a changed field or table needs `defineFolder` again.
 */
export type PreparedFolderTable<TTable extends FolderTable = FolderTable> =
	TTable & { readonly [PREPARED]: true };

/**
 * The type `defineFolder` returns: the declared definition with each table
 * marked prepared. The runtime value is the prepared definition itself.
 */
type PreparedFolderDefinition<TDefinition extends FolderDefinition> = {
	readonly [K in keyof TDefinition]: K extends 'tables'
		? {
				readonly [Name in keyof TDefinition['tables']]: TDefinition['tables'][Name] extends FolderTable
					? PreparedFolderTable<TDefinition['tables'][Name]>
					: never;
			}
		: TDefinition[K];
};

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
	const { data: prepared, error: schemaError } = prepareSchema(definition);
	if (schemaError !== null) return Err({ reason: schemaError.message });
	for (const [name, table] of Object.entries(prepared.tables)) {
		if (table.body !== undefined)
			return Err({
				reason: `Table '${name}' declares a body codec. A file folder stores the body as Markdown text; remove the codec from this definition.`,
			});
	}
	return Ok(prepared);
}

/**
 * Declare how a folder's files read without opening anything or naming a
 * folder. Tables use `defineTable` and fields use `field`, the same
 * vocabulary every Epicenter storage declares with.
 *
 * The definition is checked here, where it is written: a malformed schema, a
 * body conversion, or an `id` throws at the declaration, not at the first
 * open. What comes back has the declared shape and type, and is the prepared
 * definition: an owned, frozen snapshot of each schema. Its tables are typed
 * {@link PreparedFolderTable}, so `parseRow` and `formatRow` take them.
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
): PreparedFolderDefinition<
	Pick<TDefinition & Pick<DataSchema, 'title'>, 'title' | 'kv' | 'tables'>
> {
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
	const { data: prepared, error: definitionError } =
		prepareFolderDefinition(declaration);
	if (definitionError !== null) throw new Error(definitionError.reason);
	// The mark is a type alone: the prepared definition is returned as it is.
	return prepared as PreparedFolderDefinition<Definition>;
}
