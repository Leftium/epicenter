/**
 * defineTable() builder for creating versioned table definitions.
 *
 * All table schemas must include `_v: number` as a discriminant field.
 * Use shorthand for single-version tables, builder pattern for multiple versions with migrations.
 *
 * Optionally chain `.withDocument()` to declare named document configs on the table.
 *
 * @example
 * ```typescript
 * import { defineTable } from '@epicenter/hq';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 *
 * // Shorthand with document config
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
 * // Builder with document config
 * const notes = defineTable()
 *   .version(type({ id: 'string', bodyDocId: 'string', bodyUpdatedAt: 'number', _v: '1' }))
 *   .migrate((row) => row)
 *   .withDocument('body', { guid: 'bodyDocId', updatedAt: 'bodyUpdatedAt' });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { CombinedStandardSchema } from '../shared/standard-schema/types.js';
import { createUnionSchema } from './schema-union.js';
import type {
	BaseRow,
	DocumentConfig,
	LastSchema,
	NumberKeysOf,
	StringKeysOf,
	TableDefinition,
} from './types.js';

/**
 * A table definition with a chainable `.withDocument()` method.
 *
 * Returned by both the shorthand `defineTable(schema)` and the builder's `.migrate()`.
 * Each `.withDocument()` call accumulates a named document config into `TDocuments`.
 *
 * @typeParam TVersions - Tuple of schema versions
 * @typeParam TDocuments - Accumulated document configs
 */
type TableDefinitionWithDocBuilder<
	TVersions extends readonly CombinedStandardSchema<BaseRow>[],
	TDocuments extends Record<string, DocumentConfig>,
> = TableDefinition<TVersions, TDocuments> & {
	/**
	 * Declare a named document on this table.
	 *
	 * Maps a document concept (e.g., 'content') to a GUID column and an updatedAt column.
	 * The name becomes a property under `client.documents.{tableName}` at runtime.
	 *
	 * Chainable — call multiple times for tables with multiple documents.
	 *
	 * @param name - The document name (becomes `client.documents.{tableName}[name]`)
	 * @param config - Column mapping: `guid` (string column) and `updatedAt` (number column)
	 *
	 * @example
	 * ```typescript
	 * const files = defineTable(
	 *   type({ id: 'string', name: 'string', updatedAt: 'number', _v: '1' }),
	 * ).withDocument('content', { guid: 'id', updatedAt: 'updatedAt' });
	 *
	 * // Multiple documents
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
		// Defaults to `never` when no tags are passed. This flows into
		// DocumentConfig<..., never>, making `tags: readonly never[]` (only accepts `[]`).
		const TTags extends string = never,
	>(
		name: TName,
		config: {
			guid: TGuid;
			updatedAt: TUpdatedAt;
			tags?: readonly TTags[];
		},
	): TableDefinitionWithDocBuilder<
		TVersions,
		TDocuments & Record<TName, DocumentConfig<TGuid, TUpdatedAt, TTags>>
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
		return attachDocumentBuilder({
			schema,
			migrate: (row: unknown) => row as BaseRow,
			documents: {} as Record<string, never>,
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

			return attachDocumentBuilder({
				schema: createUnionSchema(versions),
				migrate: fn,
				documents: {},
			});
		},
	};

	return builder as unknown as TableBuilder<[]>;
}

/**
 * Create a new definition object with a `.withDocument()` chainable method.
 *
 * Each `.withDocument()` call returns a fresh object with the new document config
 * accumulated into `documents` — the original definition is never mutated.
 */
function attachDocumentBuilder<
	T extends {
		schema: CombinedStandardSchema;
		migrate: unknown;
		documents: Record<string, DocumentConfig>;
	},
>(
	def: T,
): T & {
	withDocument(name: string, config: DocumentConfig): T;
} {
	return {
		...def,
		withDocument(name: string, config: DocumentConfig) {
			return attachDocumentBuilder({
				...def,
				documents: {
					...def.documents,
					[name]: { ...config, tags: config.tags ?? [] },
				},
			});
		},
	} as T & {
		withDocument(name: string, config: DocumentConfig): T;
	};
}
