/**
 * defineKv() builder for creating versioned KV definitions.
 *
 * @example
 * ```typescript
 * import { defineKv } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
 *
 * // Builder pattern for multiple versions (without _v on v1)
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'" }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
 *   .migrate((v) => {
 *     if (!('_v' in v)) return { ...v, fontSize: 14, _v: '2' as const };
 *     return v;
 *   });
 *
 * // Or with _v from the start (symmetric switch)
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'", _v: '"1"' }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
 *   .migrate((v) => {
 *     switch (v._v) {
 *       case '1': return { mode: v.mode, fontSize: 14, _v: '2' as const };
 *       case '2': return v;
 *     }
 *   });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import { createUnionSchema } from './schema-union.js';
import type { KvDefinition, LastSchema } from './types.js';

/**
 * Builder for defining KV schemas with versioning support.
 *
 * @typeParam TVersions - Tuple of schema types added via .version() (single source of truth)
 */
type KvBuilder<TVersions extends StandardSchemaV1[]> = {
	/**
	 * Add a schema version.
	 * The last version added becomes the "latest" schema shape.
	 */
	version<TSchema extends StandardSchemaV1>(
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
export function defineKv<TSchema extends StandardSchemaV1>(
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
 * // Without _v on v1 (common — add _v only when you need a second version)
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'" }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
 *   .migrate((v) => {
 *     if (!('_v' in v)) return { ...v, fontSize: 14, _v: '2' as const };
 *     return v;
 *   });
 *
 * // With _v from the start (symmetric switch)
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'", _v: '"1"' }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
 *   .migrate((v) => {
 *     switch (v._v) {
 *       case '1': return { mode: v.mode, fontSize: 14, _v: '2' as const };
 *       case '2': return v;
 *     }
 *   });
 * ```
 */
export function defineKv(): KvBuilder<[]>;

export function defineKv<TSchema extends StandardSchemaV1>(
	schema?: TSchema,
): KvDefinition<[TSchema]> | KvBuilder<[]> {
	if (schema) {
		return {
			schema,
			migrate: (v: unknown) => v,
		} as KvDefinition<[TSchema]>;
	}

	const versions: StandardSchemaV1[] = [];

	const builder = {
		version(versionSchema: StandardSchemaV1) {
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
