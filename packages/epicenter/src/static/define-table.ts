/**
 * defineTable() builder for creating versioned table definitions.
 *
 * @example
 * ```typescript
 * import { defineTable } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string' }));
 *
 * // Builder pattern for multiple versions (without _v on v1)
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
 *   .migrate((row) => {
 *     if (!('_v' in row)) return { ...row, views: 0, _v: '2' as const };
 *     return row;
 *   });
 *
 * // Or with _v from the start (symmetric switch)
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string', _v: '"1"' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
 *   .migrate((row) => {
 *     switch (row._v) {
 *       case '1': return { ...row, views: 0, _v: '2' as const };
 *       case '2': return row;
 *     }
 *   });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { createUnionSchema } from './schema-union.js';
import type { LastSchema, TableDefinition } from './types.js';

/**
 * Builder for defining table schemas with versioning support.
 *
 * @typeParam TVersions - Tuple of schema types added via .version() (single source of truth)
 */
type TableBuilder<TVersions extends StandardSchemaV1[]> = {
	/**
	 * Add a schema version. Schema must include `{ id: string }`.
	 * The last version added becomes the "latest" schema shape.
	 */
	version<TSchema extends StandardSchemaV1>(
		schema: StandardSchemaV1.InferOutput<TSchema> extends { id: string }
			? TSchema
			: never,
	): TableBuilder<[...TVersions, TSchema]>;

	/**
	 * Provide a migration function that normalizes any version to the latest.
	 * This completes the table definition.
	 *
	 * @returns TableDefinition with TVersions tuple as the source of truth
	 */
	migrate(
		fn: (
			row: StandardSchemaV1.InferOutput<TVersions[number]>,
		) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
	): TableDefinition<TVersions>;
};

/**
 * Creates a table definition with a single schema version.
 * Schema must include `{ id: string }`.
 *
 * For single-version definitions, the TVersions tuple contains a single element.
 *
 * @example
 * ```typescript
 * const users = defineTable(type({ id: 'string', email: 'string' }));
 * ```
 */
export function defineTable<TSchema extends StandardSchemaV1>(
	schema: StandardSchemaV1.InferOutput<TSchema> extends { id: string }
		? TSchema
		: never,
): TableDefinition<[TSchema]>;

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
 *   .migrate(fn)                       // TableDefinition<[SchemaV1, SchemaV2]>
 * ```
 *
 * @example
 * ```typescript
 * // Without _v on v1 (common — add _v only when you need a second version)
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
 *   .migrate((row) => {
 *     if (!('_v' in row)) return { ...row, views: 0, _v: '2' as const };
 *     return row;
 *   });
 *
 * // With _v from the start (symmetric switch)
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string', _v: '"1"' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
 *   .migrate((row) => {
 *     switch (row._v) {
 *       case '1': return { ...row, views: 0, _v: '2' as const };
 *       case '2': return row;
 *     }
 *   });
 * ```
 */
export function defineTable(): TableBuilder<[]>;

export function defineTable<TSchema extends StandardSchemaV1>(
	schema?: TSchema,
): TableDefinition<[TSchema]> | TableBuilder<[]> {
	if (schema) {
		return {
			schema,
			migrate: (row: unknown) => row as { id: string },
		} as TableDefinition<[TSchema]>;
	}

	const versions: StandardSchemaV1[] = [];

	const builder = {
		version(versionSchema: StandardSchemaV1) {
			versions.push(versionSchema);
			return builder;
		},

		migrate(fn: (row: unknown) => unknown) {
			if (versions.length === 0) {
				throw new Error('defineTable() requires at least one .version() call');
			}

			return {
				schema: createUnionSchema(versions),
				migrate: fn,
			};
		},
	};

	return builder as unknown as TableBuilder<[]>;
}
