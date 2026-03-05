/**
 * defineKv() for creating versioned KV definitions.
 *
 * KV stores are flexible — `_v` is optional (unlike tables where it's required).
 * Use whichever pattern fits:
 * - **Shorthand**: `defineKv(schema)` — single version, no migration
 * - **Variadic**: `defineKv(v1, v2, ...).migrate(fn)` — multiple versions with migration
 * - **With `_v`**: Include `_v` for clean switch-based migrations
 * - **Field presence**: `if (!('field' in value))` — simple two-version cases
 *
 * Most KV stores never need versioning. When they do, both `_v` and field presence work well.
 *
 * @example
 * ```typescript
 * import { defineKv } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * // Shorthand for single version
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
 *
 * // Variadic with _v discriminant
 * const theme = defineKv(
 *   type({ mode: "'light' | 'dark'", _v: '1' }),
 *   type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }),
 * ).migrate((v) => {
 *   switch (v._v) {
 *     case 1: return { ...v, fontSize: 14, _v: 2 };
 *     case 2: return v;
 *   }
 * });
 *
 * // Or with field presence (simpler for two versions)
 * const theme = defineKv(
 *   type({ mode: "'light' | 'dark'" }),
 *   type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }),
 * ).migrate((v) => {
 *   if (!('fontSize' in v)) return { ...v, fontSize: 14 };
 *   return v;
 * });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { JsonValue } from 'wellcrafted/json';
import type { CombinedStandardSchema } from '../shared/standard-schema/types.js';
import { createUnionSchema } from './schema-union.js';
import type { KvDefinition, LastSchema } from './types.js';

/**
 * Creates a KV definition with a single schema version.
 *
 * Schema output must be JSON-serializable (`JsonValue`).
 *
 * For single-version definitions, TVersions is a single-element tuple.
 *
 * @example
 * ```typescript
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
 * ```
 */
export function defineKv<TSchema extends CombinedStandardSchema<JsonValue>>(
	schema: TSchema,
): KvDefinition<[TSchema]>;

/**
 * Creates a KV definition with multiple schema versions and a migration function.
 *
 * Pass 2+ schemas as arguments, then call `.migrate()` to provide the migration function.
 *
 * @example
 * ```typescript
 * // With _v discriminant
 * const theme = defineKv(
 *   type({ mode: "'light' | 'dark'", _v: '1' }),
 *   type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }),
 * ).migrate((v) => {
 *   switch (v._v) {
 *     case 1: return { ...v, fontSize: 14, _v: 2 };
 *     case 2: return v;
 *   }
 * });
 *
 * // With field presence
 * const theme = defineKv(
 *   type({ mode: "'light' | 'dark'" }),
 *   type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number' }),
 * ).migrate((v) => {
 *   if (!('fontSize' in v)) return { ...v, fontSize: 14 };
 *   return v;
 * });
 * ```
 */
export function defineKv<
	const TVersions extends [
		CombinedStandardSchema<JsonValue>,
		CombinedStandardSchema<JsonValue>,
		...CombinedStandardSchema<JsonValue>[],
	],
>(
	...versions: TVersions
): {
	migrate(
		fn: (
			value: StandardSchemaV1.InferOutput<TVersions[number]>,
		) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>,
	): KvDefinition<TVersions>;
};

export function defineKv<TSchema extends CombinedStandardSchema<JsonValue>>(
	...args: [TSchema, ...CombinedStandardSchema<JsonValue>[]]
):
	| KvDefinition<[TSchema]>
	| {
			migrate(
				fn: (value: unknown) => unknown,
			): KvDefinition<CombinedStandardSchema[]>;
	  } {
	if (args.length === 0) {
		throw new Error('defineKv() requires at least one schema argument');
	}

	if (args.length === 1) {
		const schema = args[0];
		return {
			schema,
			migrate: (v: unknown) => v,
		} as KvDefinition<[TSchema]>;
	}

	const versions = args as CombinedStandardSchema[];

	return {
		migrate(fn: (value: unknown) => unknown) {
			return {
				schema: createUnionSchema(versions),
				migrate: fn,
			};
		},
	} as unknown as {
		migrate(
			fn: (value: unknown) => unknown,
		): KvDefinition<CombinedStandardSchema[]>;
	};
}
