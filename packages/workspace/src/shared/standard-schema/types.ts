/**
 * Epicenter-specific Standard Schema extensions.
 *
 * Upstream spec types (`StandardSchemaV1`, `StandardJSONSchemaV1`, etc.)
 * should be imported directly from `@standard-schema/spec`.
 *
 * @see https://standardschema.dev
 * @see https://github.com/standard-schema/standard-schema
 */

import type {
	StandardJSONSchemaV1,
	StandardSchemaV1,
} from '@standard-schema/spec';

// ###############################
// ###   Epicenter Extensions  ###
// ###############################

/**
 * Schema type that implements both StandardSchema (validation) and StandardJSONSchema (conversion).
 *
 * Use this as a constraint when you need:
 * 1. Runtime validation via `~standard.validate()`
 * 2. JSON Schema generation via `~standard.jsonSchema.input()`
 *
 * ArkType, Zod (v4.2+), and Valibot (with adapter) all implement both specs.
 *
 * @example
 * ```typescript
 * // ArkType
 * import { type } from 'arktype';
 * type('string') satisfies CombinedStandardSchema; // ✅
 *
 * // Zod (v4.2+)
 * import * as z from 'zod';
 * z.string() satisfies CombinedStandardSchema; // ✅
 * ```
 */
export type CombinedStandardSchema<TInput = unknown, TOutput = TInput> = {
	'~standard': StandardSchemaV1.Props<TInput, TOutput> &
		StandardJSONSchemaV1.Props<TInput, TOutput>;
};
