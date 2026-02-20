/**
 * defineTable() builder for creating versioned table definitions.
 *
 * All table schemas must include `_v: number` as a discriminant field.
 * Use shorthand for single-version tables, builder pattern for multiple versions with migrations.
 *
 * Optionally chain `.withDocument()` to declare named document bindings on the table.
 *
 * @example
 * ```typescript
 * import { defineTable } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 *
 * // Shorthand with document binding
 * const files = defineTable(
 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
 * ).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });
 *
 * // Builder pattern for multiple versions with migration
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string', _v: '1' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
 *   .migrate((row) => {
 *     switch (row._v) {
 *       case 1: return { ...row, views: 0, _v: 2 };
 *       case 2: return row;
 *     }
 *   });
 *
 * // Builder with document binding
 * const notes = defineTable()
 *   .version(type({ id: 'string', bodyDocId: 'string', bodyUpdatedAt: 'number', _v: '1' }))
 *   .migrate((row) => row)
 *   .withDocument('body', { guid: 'bodyDocId', updatedAt: 'bodyUpdatedAt' });
 * ```
 */

import type {
	CombinedStandardSchema,
	StandardSchemaV1,
} from '../shared/standard-schema/types.js';
import { createUnionSchema } from './schema-union.js';
import type {
	BaseRow,
	DocBinding,
	LastSchema,
	NumberKeysOf,
	StringKeysOf,
	TableDefinition,
} from './types.js';

/**
 * A table definition with a chainable `.withDocument()` method.
 *
 * Returned by both the shorthand `defineTable(schema)` and the builder's `.migrate()`.
 * Each `.withDocument()` call accumulates a named binding into `TDocs`.
 *
 * @typeParam TVersions - Tuple of schema versions
 * @typeParam TDocs - Accumulated document bindings
 */
type TableDefinitionWithDocBuilder<
	TVersions extends readonly CombinedStandardSchema<BaseRow>[],
	TDocs extends Record<string, DocBinding<string, string, string>>,
> = TableDefinition<TVersions, TDocs> & {
	/**
	 * Declare a named document binding on this table.
	 *
	 * Maps a document concept (e.g., 'content') to a GUID column and an updatedAt column.
	 * The name becomes a property under `.docs` on the table helper at runtime.
	 *
	 * Chainable — call multiple times for tables with multiple document bindings.
	 *
	 * @param name - The binding name (becomes `table.docs[name]`)
	 * @param binding - Column mapping: `guid` (string column) and `updatedAt` (number column)
	 *
	 * @example
	 * ```typescript
	 * const files = defineTable(
	 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
	 * ).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });
	 *
	 * // Multiple bindings
	 * const notes = defineTable(
	 *   type({ id: 'string', bodyDocId: 'string', coverDocId: 'string',
	 *          bodyUpdatedAt: 'number', coverUpdatedAt: 'number', _v: '1' }),
	 * )
	 *   .withDocument('body', { guid: 'bodyDocId', updatedAt: 'bodyUpdatedAt' })
	 *   .withDocument('cover', { guid: 'coverDocId', updatedAt: 'coverUpdatedAt' });
	 * ```
	 */
	withDocument<
		TName extends string,
		TGuid extends StringKeysOf<
			StandardSchemaV1.InferOutput<LastSchema<TVersions>>
		>,
		TUpdatedAt extends NumberKeysOf<
			StandardSchemaV1.InferOutput<LastSchema<TVersions>>
		>,
		const TTags extends string = never,
	>(
		name: TName,
		binding: {
			guid: TGuid;
			updatedAt: TUpdatedAt;
			tags?: TTags | readonly TTags[];
		},
	): TableDefinitionWithDocBuilder<
		TVersions,
		TDocs & Record<TName, DocBinding<TGuid, TUpdatedAt, TTags>>
	>;
};

/**
 * Builder for defining table schemas with versioning support.
 *
 * @typeParam TVersions - Tuple of schema types added via .version() (single source of truth)
 */
type TableBuilder<TVersions extends CombinedStandardSchema<BaseRow>[]> = {
	/**
	 * Add a schema version. Schema must include `{ id: string, _v: number }`.
	 * The last version added becomes the "latest" schema shape.
	 */
	version<TSchema extends CombinedStandardSchema<BaseRow>>(
		schema: TSchema,
	): TableBuilder<[...TVersions, TSchema]>;

	/**
	 * Provide a migration function that normalizes any version to the latest.
	 * This completes the table definition.
	 *
	 * @returns TableDefinition with TVersions tuple as the source of truth, plus `.withDocument()` chaining
	 */
	migrate(
		fn: (
			row: StandardSchemaV1.InferOutput<TVersions[number]>,
		) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
	): TableDefinitionWithDocBuilder<TVersions, Record<string, never>>;
};

/**
 * Creates a table definition with a single schema version.
 * Schema must include `{ id: string, _v: number }`.
 *
 * For single-version definitions, the TVersions tuple contains a single element.
 *
 * @example
 * ```typescript
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 * ```
 */
export function defineTable<TSchema extends CombinedStandardSchema<BaseRow>>(
	schema: TSchema,
): TableDefinitionWithDocBuilder<[TSchema], Record<string, never>>;

/**
 * Creates a table definition builder for multiple versions with migrations.
 *
 * Returns `TableBuilder<[]>` - an empty builder with no versions yet.
 * You must call `.version()` at least once before `.migrate()`.
 *
 * The return type evolves as you chain calls:
 * ```typescript
 * defineTable()                        // TableBuilder<[]>
 *   .version(schemaV1)                 // TableBuilder<[SchemaV1]>
 *   .version(schemaV2)                 // TableBuilder<[SchemaV1, SchemaV2]>
 *   .migrate(fn)                       // TableDefinitionWithDocBuilder<...>
 *   .withDocument('content', {...})    // TableDefinitionWithDocBuilder<..., { content: ... }>
 * ```
 *
 * @example
 * ```typescript
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string', _v: '1' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
 *   .migrate((row) => {
 *     switch (row._v) {
 *       case 1: return { ...row, views: 0, _v: 2 };
 *       case 2: return row;
 *     }
 *   });
 * ```
 */
export function defineTable(): TableBuilder<[]>;

export function defineTable<TSchema extends CombinedStandardSchema<BaseRow>>(
	schema?: TSchema,
):
	| TableDefinitionWithDocBuilder<[TSchema], Record<string, never>>
	| TableBuilder<[]> {
	if (schema) {
		return addWithDocument({
			schema,
			migrate: (row: unknown) => row as BaseRow,
			docs: {} as Record<string, never>,
		}) as unknown as TableDefinitionWithDocBuilder<
			[TSchema],
			Record<string, never>
		>;
	}

	const versions: CombinedStandardSchema[] = [];

	const builder = {
		version(versionSchema: CombinedStandardSchema) {
			versions.push(versionSchema);
			return builder;
		},

		migrate(fn: (row: unknown) => unknown) {
			if (versions.length === 0) {
				throw new Error('defineTable() requires at least one .version() call');
			}

			return addWithDocument({
				schema: createUnionSchema(versions),
				migrate: fn,
				docs: {},
			});
		},
	};

	return builder as unknown as TableBuilder<[]>;
}

/**
 * Create a new definition object with a `.withDocument()` chainable method.
 *
 * Each `.withDocument()` call returns a fresh object with the new binding
 * accumulated into `docs` — the original definition is never mutated.
 */
function addWithDocument<
	T extends {
		schema: CombinedStandardSchema;
		migrate: unknown;
		docs: Record<string, DocBinding<string, string, string>>;
	},
>(
	def: T,
): T & {
	withDocument(name: string, binding: DocBinding<string, string, string>): T;
} {
	return {
		...def,
		withDocument(name: string, binding: DocBinding<string, string, string>) {
			// Normalize tags to readonly array for storage
			const tags = binding.tags
				? typeof binding.tags === 'string'
					? [binding.tags]
					: binding.tags
				: undefined;
			return addWithDocument({
				...def,
				docs: {
					...def.docs,
					[name]: { guid: binding.guid, updatedAt: binding.updatedAt, tags },
				},
			});
		},
	} as T & {
		withDocument(name: string, binding: DocBinding<string, string, string>): T;
	};
}
