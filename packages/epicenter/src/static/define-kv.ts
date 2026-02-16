/**
 * defineKv() builder for creating versioned KV definitions.
 *
 * KV stores are flexible — `_v` is optional (unlike tables where it's required).
 * Use whichever pattern fits:
 * - **Shorthand**: `defineKv(schema)` — single version, no migration
 * - **With `_v`**: Include `_v` for clean switch-based migrations
 * - **Field presence**: `if (!('field' in value))` — simple two-version cases
 *
 * Most KV stores never need versioning. When they do, both `_v` and field presence work well.
 *
 * @example
 * ```typescript
 * import { defineKv } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
 *
 * // Builder pattern with _v discriminant
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'", _v: '1' }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }))
 *   .migrate((v) => {
 *     switch (v._v) {
 *       case 1: return { ...v, fontSize: 14, _v: 2 };
 *       case 2: return v;
 *     }
 *   });
 *
 * // Or with field presence (simpler for two versions)
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'" }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }))
 *   .migrate((v) => {
 *     if (!('fontSize' in v)) return { ...v, fontSize: 14 };
 *     return v;
 *   });
 * ```
 */

import type {
	CombinedStandardSchema,
	StandardSchemaV1,
} from '../shared/standard-schema/types.js';
import { createUnionSchema } from './schema-union.js';
import type { KvDefinition, LastSchema } from './types.js';

/**
 * Builder for defining KV schemas with versioning support.
 *
 * @typeParam TVersions - Tuple of schema types added via .version() (single source of truth)
 */
type KvBuilder<TVersions extends CombinedStandardSchema[]> = {
	/**
	 * Add a schema version.
	 * The last version added becomes the "latest" schema shape.
	 */
	version<TSchema extends CombinedStandardSchema>(
		schema: TSchema,
	): KvBuilder<[...TVersions, TSchema]>;

	/**
	 * Provide a migration function that normalizes any version to the latest.
	 * This completes the KV definition.
	 *
	 * @returns KvDefinition with TVersions tuple as the source of truth
	 */
	migrate(
		fn: (
			value: StandardSchemaV1.InferOutput<TVersions[number]>,
		) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
	): KvDefinition<TVersions>;
};

/**
 * Creates a KV definition with a single schema version.
 *
 * For single-version definitions, TVersions is a single-element tuple.
 *
 * @example
 * ```typescript
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
 * ```
 */
export function defineKv<TSchema extends CombinedStandardSchema>(
	schema: TSchema,
): KvDefinition<[TSchema]>;

/**
 * Creates a KV definition builder for multiple versions with migrations.
 *
 * Returns `KvBuilder<[]>` - an empty builder with no versions yet.
 * You must call `.version()` at least once before `.migrate()`.
 *
 * The return type evolves as you chain calls:
 * ```typescript
 * defineKv()                           // KvBuilder<[]>
 *   .version(schemaV1)                 // KvBuilder<[SchemaV1]>
 *   .version(schemaV2)                 // KvBuilder<[SchemaV1, SchemaV2]>
 *   .migrate(fn)                       // KvDefinition<[SchemaV1, SchemaV2]>
 * ```
 *
 * @example
 * ```typescript
 * // Symmetric _v — include _v from the start for clean switch statements
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'", _v: '1' }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }))
 *   .migrate((v) => {
 *     switch (v._v) {
 *       case 1: return { ...v, fontSize: 14, _v: 2 };
 *       case 2: return v;
 *     }
 *   });
 *
 * // Asymmetric _v — add _v only when you need a second version
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'" }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }))
 *   .migrate((v) => {
 *     if (!('_v' in v)) return { ...v, fontSize: 14, _v: 2 };
 *     return v;
 *   });
 * ```
 */
export function defineKv(): KvBuilder<[]>;

export function defineKv<TSchema extends CombinedStandardSchema>(
	schema?: TSchema,
): KvDefinition<[TSchema]> | KvBuilder<[]> {
	if (schema) {
		return {
			schema,
			migrate: (v: unknown) => v,
		} as KvDefinition<[TSchema]>;
	}

	const versions: CombinedStandardSchema[] = [];

	const builder = {
		version(versionSchema: CombinedStandardSchema) {
			versions.push(versionSchema);
			return builder;
		},

		migrate(fn: (value: unknown) => unknown) {
			if (versions.length === 0) {
				throw new Error('defineKv() requires at least one .version() call');
			}

			return {
				schema: createUnionSchema(versions),
				migrate: fn,
			};
		},
	};

	return builder as unknown as KvBuilder<[]>;
}
