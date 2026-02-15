/**
 * defineTable() builder for creating versioned table definitions.
 *
 * **Versioning patterns:**
 * - **Shorthand**: `defineTable(schema)` — single version, no migration yet
 * - **Symmetric `_v`**: Include `_v: '1'` from start — clean switch statements (recommended default)
 * - **Asymmetric `_v`**: No `_v` on v1, add on v2+ — less ceremony upfront
 * - **Field presence**: `if (!('field' in row))` — simple two-version cases only
 *
 * Symmetric `_v` (include `_v` from the start) is the recommended default for tables that may evolve.
 * Use asymmetric `_v` when you want less ceremony upfront and don't expect versioning.
 * Use field presence for unambiguous two-version cases.
 *
 * See `.agents/skills/static-workspace-api/SKILL.md` for detailed comparison table.
 *
 * @example
 * ```typescript
 * import { defineTable } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version (with _v from the start)
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 *
 * // Builder pattern for multiple versions (symmetric _v — recommended)
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
 * // Or with asymmetric _v (less ceremony upfront)
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
 *   .migrate((row) => {
 *     if (!('_v' in row)) return { ...row, views: 0, _v: 2 };
 *     return row;
 *   });
 * ```
 */

import type {
	CombinedStandardSchema,
	StandardSchemaV1,
} from '../shared/standard-schema/types.js';
import { createUnionSchema } from './schema-union.js';
import type { LastSchema, TableDefinition } from './types.js';

/**
 * Builder for defining table schemas with versioning support.
 *
 * @typeParam TVersions - Tuple of schema types added via .version() (single source of truth)
 */
type TableBuilder<TVersions extends CombinedStandardSchema<{ id: string }>[]> =
	{
		/**
		 * Add a schema version. Schema must include `{ id: string }`.
		 * The last version added becomes the "latest" schema shape.
		 */
		version<TSchema extends CombinedStandardSchema<{ id: string }>>(
			schema: TSchema,
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
export function defineTable<
	TSchema extends CombinedStandardSchema<{ id: string }>,
>(schema: TSchema): TableDefinition<[TSchema]>;

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
 * // Symmetric _v (recommended) — include _v from the start for clean switch statements
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
 * // Asymmetric _v — add _v only when you need a second version
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
 *   .migrate((row) => {
 *     if (!('_v' in row)) return { ...row, views: 0, _v: 2 };
 *     return row;
 *   });
 * ```
 */
export function defineTable(): TableBuilder<[]>;

export function defineTable<
	TSchema extends CombinedStandardSchema<{ id: string }>,
>(schema?: TSchema): TableDefinition<[TSchema]> | TableBuilder<[]> {
	if (schema) {
		return {
			schema,
			migrate: (row: unknown) => row as { id: string },
		} as TableDefinition<[TSchema]>;
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

			return {
				schema: createUnionSchema(versions),
				migrate: fn,
			};
		},
	};

	return builder as unknown as TableBuilder<[]>;
}
