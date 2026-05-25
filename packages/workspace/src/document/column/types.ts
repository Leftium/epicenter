/**
 * Option types shared across the `column.*` sugar layer.
 *
 * These are intentionally narrower than TypeBox's `TSchemaOptions` (which has a
 * `[key: PropertyKey]: unknown` index signature plus `default`, `readOnly`,
 * `$id`, etc.) so that autocomplete on `column.X({ })` lists only the keywords
 * that have a CRDT, SQLite, or MCP consumer. Users who need the full
 * `TSchemaOptions` can drop from `column.X(opts)` to `Type.X(opts)`; the
 * `FlatJsonTSchema` constraint does not care which call site produced the
 * schema.
 */

import type { TFormat } from 'typebox';

/**
 * JSON Schema metadata keywords applicable to any column helper. These are
 * annotations that describe a schema for human readers and codegen, without
 * changing what the schema validates.
 */
export type SchemaMetadata = {
	/** Surfaces in MCP tool docs, CLI flag help, RPC contract documentation. */
	description?: string;
	/** Example payloads for MCP tools and codegen. */
	examples?: unknown[];
	/** Mark the column as deprecated; propagates to MCP and CLI surfaces. */
	deprecated?: boolean;
};

/** Per-string keywords plus shared metadata. */
export type StringOpts = SchemaMetadata & {
	format?: TFormat;
	pattern?: string | RegExp;
	minLength?: number;
	maxLength?: number;
};

/** Per-numeric keywords plus shared metadata. */
export type NumberOpts = SchemaMetadata & {
	minimum?: number;
	maximum?: number;
	exclusiveMinimum?: number;
	exclusiveMaximum?: number;
	multipleOf?: number;
};
