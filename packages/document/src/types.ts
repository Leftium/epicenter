/**
 * Shared types for the table/kv/awareness primitives in `@epicenter/document`.
 *
 * These were previously defined in `@epicenter/workspace`. They live here now
 * because `attachTable`, `attachKv`, and `attachAwareness` are the canonical
 * implementations — the workspace package re-exports these types and wraps
 * the helpers with the encrypted-store pathway.
 */

import type {
	StandardJSONSchemaV1,
	StandardSchemaV1,
} from '@standard-schema/spec';
import type { JsonObject } from 'wellcrafted/json';
import type { Awareness } from 'y-protocols/awareness';

// ════════════════════════════════════════════════════════════════════════════
// STANDARD SCHEMA HELPERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Schema type that implements both StandardSchema (validation) and StandardJSONSchema (conversion).
 *
 * ArkType, Zod (v4.2+), and Valibot (with adapter) all implement both specs.
 */
export type CombinedStandardSchema<TInput = unknown, TOutput = TInput> = {
	'~standard': StandardSchemaV1.Props<TInput, TOutput> &
		StandardJSONSchemaV1.Props<TInput, TOutput>;
};

// ════════════════════════════════════════════════════════════════════════════
// TABLE RESULT TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The minimum shape every versioned table row must satisfy.
 *
 * - `id`: Unique identifier for row lookup and identity
 * - `_v`: Schema version number for tracking which version this row conforms to
 *
 * Intersected with `JsonObject` to ensure all field values are JSON-serializable.
 */
export type BaseRow = { id: string; _v: number } & JsonObject;

/** A row that passed validation. */
export type ValidRowResult<TRow> = { status: 'valid'; row: TRow };

/** A row that exists but failed validation. */
export type InvalidRowResult = {
	status: 'invalid';
	id: string;
	errors: readonly StandardSchemaV1.Issue[];
	row: unknown;
};

/**
 * A row that was not found.
 * Includes `row: undefined` so row can always be destructured regardless of status.
 */
export type NotFoundResult = {
	status: 'not_found';
	id: string;
	row: undefined;
};

/** Result of validating a row. */
export type RowResult<TRow> = ValidRowResult<TRow> | InvalidRowResult;

/** Result of getting a single row by ID. */
export type GetResult<TRow> = RowResult<TRow> | NotFoundResult;

/** Result of updating a single row */
export type UpdateResult<TRow> =
	| { status: 'updated'; row: TRow }
	| NotFoundResult
	| InvalidRowResult;

// ════════════════════════════════════════════════════════════════════════════
// KV RESULT TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Change event for KV observation */
export type KvChange<TValue> =
	| { type: 'set'; value: TValue }
	| { type: 'delete' };

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Extract the last element from a tuple of schemas. */
export type LastSchema<T extends readonly CombinedStandardSchema[]> =
	T extends readonly [
		...CombinedStandardSchema[],
		infer L extends CombinedStandardSchema,
	]
		? L
		: T[number];

/**
 * A table definition created by `defineTable(schema)` or `defineTable(v1, v2, ...).migrate(fn)`.
 *
 * Workspace's `TableDefinition` is a structural superset — it adds a
 * `documents` field via `.withDocument()`. Values from workspace's wider
 * type satisfy this one by subtyping.
 *
 * @typeParam TVersions - Tuple of schema versions (each must include `{ id: string }`)
 */
export type TableDefinition<
	TVersions extends readonly CombinedStandardSchema<BaseRow>[] = readonly CombinedStandardSchema<BaseRow>[],
> = {
	schema: CombinedStandardSchema<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		row: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
};

/** Extract the row type from a TableDefinition */
export type InferTableRow<T> = T extends {
	migrate: (...args: never[]) => infer TLatest;
}
	? TLatest
	: never;

/** Map of table definitions (uses `any` to allow variance in generic parameters) */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any>
>;

// ════════════════════════════════════════════════════════════════════════════
// TABLE HELPER TYPE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Type-safe table helper for a single workspace table.
 *
 * Provides CRUD operations with schema validation and migration on read.
 *
 * @typeParam TRow - The fully-typed row shape for this table (extends `{ id: string }`)
 */
export type TableHelper<TRow extends BaseRow> = {
	/**
	 * Parse unknown input against the table schema and migrate to the latest version.
	 *
	 * Injects `id` into the input before validation. Does not write to storage.
	 */
	parse(id: string, input: unknown): RowResult<TRow>;

	/** Set a row (insert or replace). Always writes the full row. */
	set(row: TRow): void;

	/** Insert or replace many rows with chunked transactions and progress reporting. */
	bulkSet(
		rows: TRow[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;

	/** Get a single row by ID. */
	get(id: string): GetResult<TRow>;

	/** Get all rows with their validation status. */
	getAll(): RowResult<TRow>[];

	/** Get all rows that pass schema validation. */
	getAllValid(): TRow[];

	/** Get all rows that fail schema validation. */
	getAllInvalid(): InvalidRowResult[];

	/** Filter valid rows by predicate. */
	filter(predicate: (row: TRow) => boolean): TRow[];

	/** Find the first valid row matching a predicate. */
	find(predicate: (row: TRow) => boolean): TRow | undefined;

	/** Partial update a row by ID. */
	update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow>;

	/** Delete a single row by ID. */
	delete(id: string): void;

	/** Delete many rows by ID with chunked operations and progress reporting. */
	bulkDelete(
		ids: string[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;

	/** Delete all rows from the table. */
	clear(): void;

	/** Watch for row changes. */
	observe(
		callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
	): () => void;

	/** Get the total number of rows in the table. */
	count(): number;

	/** Check if a row exists by ID. */
	has(id: string): boolean;
};

/** Map keyed by table name to TableHelper for that table's row type. */
export type TablesHelper<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: TableHelper<
		InferTableRow<TTableDefinitions[K]>
	>;
};

// ════════════════════════════════════════════════════════════════════════════
// KV DEFINITION & HELPER TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A KV definition created by `defineKv(schema, defaultValue)`.
 */
export type KvDefinition<TSchema extends CombinedStandardSchema> = {
	schema: TSchema;
	defaultValue: StandardSchemaV1.InferOutput<TSchema>;
};

/** Extract the value type from a KvDefinition */
export type InferKvValue<T> =
	T extends KvDefinition<infer TSchema>
		? StandardSchemaV1.InferOutput<TSchema>
		: never;

/** Map of KV definitions (uses `any` to allow variance in generic parameters) */
export type KvDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	KvDefinition<any>
>;

/**
 * KV helper with dictionary-style access to typed key-value entries.
 */
export type KvHelper<TKvDefinitions extends KvDefinitions> = {
	get<K extends keyof TKvDefinitions & string>(
		key: K,
	): InferKvValue<TKvDefinitions[K]>;

	set<K extends keyof TKvDefinitions & string>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;

	delete<K extends keyof TKvDefinitions & string>(key: K): void;

	observe<K extends keyof TKvDefinitions & string>(
		key: K,
		callback: (
			change: KvChange<InferKvValue<TKvDefinitions[K]>>,
			origin?: unknown,
		) => void,
	): () => void;

	observeAll(
		callback: (
			changes: Map<keyof TKvDefinitions & string, KvChange<unknown>>,
			origin?: unknown,
		) => void,
	): () => void;

	getAll(): {
		[K in keyof TKvDefinitions & string]: InferKvValue<TKvDefinitions[K]>;
	};
};

// ════════════════════════════════════════════════════════════════════════════
// AWARENESS TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Map of awareness field definitions. Each field has its own CombinedStandardSchema schema. */
export type AwarenessDefinitions = Record<string, CombinedStandardSchema>;

/** Extract the output type of an awareness field's schema. */
export type InferAwarenessValue<T> =
	T extends CombinedStandardSchema<unknown, infer TOutput> ? TOutput : never;

/**
 * The composed state type — all fields optional since peers may not have set every field.
 */
export type AwarenessState<TDefs extends AwarenessDefinitions> = {
	[K in keyof TDefs]?: InferAwarenessValue<TDefs[K]>;
};

/**
 * Helper for typed awareness access.
 * Wraps the raw y-protocols Awareness instance with schema-validated methods.
 */
export type AwarenessHelper<TDefs extends AwarenessDefinitions> = {
	setLocal(state: AwarenessState<TDefs>): void;

	setLocalField<K extends keyof TDefs & string>(
		key: K,
		value: InferAwarenessValue<TDefs[K]>,
	): void;

	getLocal(): AwarenessState<TDefs> | null;

	getLocalField<K extends keyof TDefs & string>(
		key: K,
	): InferAwarenessValue<TDefs[K]> | undefined;

	getAll(): Map<number, AwarenessState<TDefs>>;

	peers(): Map<number, AwarenessState<TDefs>>;

	observe(
		callback: (changes: Map<number, 'added' | 'updated' | 'removed'>) => void,
	): () => void;

	raw: Awareness;
};
