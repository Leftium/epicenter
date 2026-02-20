/**
 * Shared types for the Static Workspace API.
 *
 * This module contains all type definitions for versioned tables and KV stores.
 */

import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type {
	DocumentContext,
	DocumentLifecycle,
	Extension,
} from '../shared/lifecycle.js';
import type {
	CombinedStandardSchema,
	StandardSchemaV1,
} from '../shared/standard-schema/types.js';

// ════════════════════════════════════════════════════════════════════════════
// TABLE RESULT TYPES - Building Blocks
// ════════════════════════════════════════════════════════════════════════════

/**
 * The minimum shape every versioned table row must satisfy.
 *
 * - `id`: Unique identifier for row lookup and identity
 * - `_v`: Schema version number for tracking which version this row conforms to
 *
 * All table rows extend this base shape. Used as a constraint in generic types
 * to ensure rows have the required fields for versioning and identification.
 */
export type BaseRow = { id: string; _v: number };

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

// ════════════════════════════════════════════════════════════════════════════
// TABLE RESULT TYPES - Composed Types
// ════════════════════════════════════════════════════════════════════════════

/**
 * Result of validating a row.
 * The shape after parsing a row from storage - either valid or invalid.
 */
export type RowResult<TRow> = ValidRowResult<TRow> | InvalidRowResult;

/**
 * Result of getting a single row by ID.
 * Includes not_found since the row may not exist.
 */
export type GetResult<TRow> = RowResult<TRow> | NotFoundResult;

/** Result of deleting a single row */
export type DeleteResult =
	| { status: 'deleted' }
	| { status: 'not_found_locally' };

/** Result of updating a single row */
export type UpdateResult<TRow> =
	| { status: 'updated'; row: TRow }
	| NotFoundResult
	| InvalidRowResult;

// ════════════════════════════════════════════════════════════════════════════
// KV RESULT TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Result of getting a KV value */
export type KvGetResult<TValue> =
	| { status: 'valid'; value: TValue }
	| {
			status: 'invalid';
			errors: readonly StandardSchemaV1.Issue[];
			value: unknown;
	  }
	| { status: 'not_found'; value: undefined };

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
 * A table definition created by defineTable().version().migrate()
 *
 * @typeParam TVersions - Tuple of schema versions (each must include `{ id: string }`)
 * @typeParam TDocs - Record of named document bindings declared via `.withDocument()`
 */
export type TableDefinition<
	TVersions extends readonly CombinedStandardSchema<{
		id: string;
		_v: number;
	}>[],
	TDocs extends Record<string, DocBinding<string, string, string>> = Record<
		string,
		never
	>,
> = {
	schema: CombinedStandardSchema<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		row: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
	docs: TDocs;
};

/** Extract the row type from a TableDefinition */
export type InferTableRow<T> = T extends {
	migrate: (...args: never[]) => infer TLatest;
}
	? TLatest
	: never;

/** Extract the version union type from a TableDefinition */
export type InferTableVersionUnion<T> = T extends {
	schema: CombinedStandardSchema<unknown, infer TOutput>;
}
	? TOutput
	: never;

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT BINDING TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A named document binding declared via `.withDocument()`.
 *
 * Maps a document concept (e.g., 'content') to two columns on the table:
 * - `guid`: The column storing the Y.Doc GUID (must be a string column)
 * - `updatedAt`: The column to bump when the doc changes (must be a number column)
 * - `tags`: Optional tag literals for document extension targeting
 *
 * @typeParam TGuid - Literal string type of the guid column name
 * @typeParam TUpdatedAt - Literal string type of the updatedAt column name
 * @typeParam TTags - Literal union of tag strings (defaults to `never` = no tags)
 */
export type DocBinding<
	TGuid extends string,
	TUpdatedAt extends string,
	TTags extends string = never,
> = {
	guid: TGuid;
	updatedAt: TUpdatedAt;
	tags?: [TTags] extends [never] ? undefined : readonly TTags[];
};

/**
 * Internal registration for a document extension.
 *
 * Stored in an array by `withDocumentExtension()`. Each entry contains
 * the extension key, factory function, and optional tag filter.
 *
 * At document open time, the runtime iterates registrations and fires
 * factories whose tags match (set intersection) or have no tags (universal).
 */
export type DocumentExtensionRegistration = {
	key: string;
	factory: (context: DocumentContext) => DocumentLifecycle | void;
	tags: readonly string[];
};

/** Extract tags from a single DocBinding. */
export type ExtractDocTags<T> =
	T extends DocBinding<string, string, infer TTags> ? TTags : never;

/**
 * Extract all tags across all tables' document bindings.
 *
 * Collects all tag literal types from all table definitions into a union
 * for type-safe autocomplete in `withDocumentExtension({ tags: [...] })`.
 *
 * @example
 * ```typescript
 * // Given tables with tags ['persistent', 'synced'] and ['ephemeral']:
 * type Tags = ExtractAllDocTags<typeof tables>;
 * // => 'persistent' | 'synced' | 'ephemeral'
 * ```
 */
export type ExtractAllDocTags<TTableDefs extends TableDefinitions> = {
	[K in keyof TTableDefs]: TTableDefs[K] extends { docs: infer TDocs }
		? TDocs extends Record<string, infer TBinding>
			? ExtractDocTags<TBinding>
			: never
		: never;
}[keyof TTableDefs];

/**
 * Extract keys of `TRow` whose value type extends `string`.
 * Used to constrain the `guid` parameter of `.withDocument()`.
 */
export type StringKeysOf<TRow> = {
	[K in keyof TRow & string]: TRow[K] extends string ? K : never;
}[keyof TRow & string];

/**
 * Extract keys of `TRow` whose value type extends `number`.
 * Used to constrain the `updatedAt` parameter of `.withDocument()`.
 */
export type NumberKeysOf<TRow> = {
	[K in keyof TRow & string]: TRow[K] extends number ? K : never;
}[keyof TRow & string];

/**
 * The runtime document binding — a bidirectional link between a table row
 * and its content Y.Doc. Returned by `createDocumentBinding()`.
 *
 * Manages Y.Doc creation, provider lifecycle, `updatedAt` auto-bumping,
 * and cleanup on row deletion.
 *
 * @typeParam TRow - The row type of the bound table
 *
 * @example
 * ```typescript
 * const doc = await binding.open(row);
 * doc.getText('body').insert(0, 'hello');
 * // updatedAt on the row is bumped automatically
 *
 * const text = await binding.read(row);
 * await binding.write(row, 'new content');
 * await binding.destroy(row);
 * ```
 */
export type DocumentBinding<TRow extends BaseRow> = {
	/**
	 * Open a content Y.Doc for a row.
	 *
	 * Creates the Y.Doc if it doesn't exist, wires up providers, and attaches
	 * the updatedAt observer. Idempotent — calling open() twice for the same
	 * row returns the same Y.Doc.
	 *
	 * @param input - A row (extracts GUID from the bound column) or a GUID string
	 */
	open(input: TRow | string): Promise<Y.Doc>;

	/**
	 * Read document content as plain text.
	 *
	 * Opens the doc (if not already open) and reads the text content.
	 * For domain-specific reading, use open() and work with the Y.Doc directly.
	 *
	 * @param input - A row or GUID string
	 */
	read(input: TRow | string): Promise<string>;

	/**
	 * Write plain text to a document.
	 *
	 * Opens the doc (if not already open) and replaces the text content.
	 * The updatedAt observer fires automatically.
	 *
	 * @param input - A row or GUID string
	 * @param text - The text content to write
	 */
	write(input: TRow | string, text: string): Promise<void>;

	/**
	 * Destroy a document — free memory, disconnect providers.
	 * Persisted data is NOT deleted. The doc can be re-opened later.
	 *
	 * @param input - A row or GUID string
	 */
	destroy(input: TRow | string): Promise<void>;

	/**
	 * Purge a document — destroy AND delete all persisted data.
	 * This is permanent. The document cannot be recovered.
	 *
	 * @param input - A row or GUID string
	 */
	purge(input: TRow | string): Promise<void>;

	/**
	 * Destroy all open documents. Called automatically by workspace destroy().
	 */
	destroyAll(): Promise<void>;

	/** Extract the GUID from a row (reads the bound guid column). */
	guidOf(row: TRow): string;

	/** Extract the updatedAt value from a row (reads the bound updatedAt column). */
	updatedAtOf(row: TRow): number;
};

/**
 * Conditionally adds a `docs` property to a table helper when the table
 * has document bindings declared via `.withDocument()`.
 *
 * - Tables with no `.withDocument()` → no `docs` property (empty intersection)
 * - Tables with `.withDocument()` → `{ docs: { [name]: DocumentBinding<TRow> } }`
 *
 * @example
 * ```typescript
 * // Table with docs
 * client.tables.files.docs.content.open(row)
 *
 * // Table without docs — TypeScript error
 * client.tables.tags.docs // Property 'docs' does not exist
 * ```
 */
export type DocsPropertyOf<T> = T extends {
	docs: infer TDocs;
	migrate: (...args: never[]) => infer TLatest;
}
	? TLatest extends BaseRow
		? keyof TDocs extends never
			? {} // no .withDocument() → no .docs property
			: {
					docs: {
						[K in keyof TDocs]: DocumentBinding<TLatest>;
					};
				}
		: {}
	: {};

// ════════════════════════════════════════════════════════════════════════════
// KV DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A KV definition created by defineKv().version().migrate()
 *
 * @typeParam TVersions - Tuple of schema versions
 */
export type KvDefinition<TVersions extends readonly CombinedStandardSchema[]> =
	{
		schema: CombinedStandardSchema<
			unknown,
			StandardSchemaV1.InferOutput<TVersions[number]>
		>;
		migrate: (
			value: StandardSchemaV1.InferOutput<TVersions[number]>,
		) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
	};

/** Extract the value type from a KvDefinition */
export type InferKvValue<T> =
	T extends KvDefinition<infer V>
		? StandardSchemaV1.InferOutput<LastSchema<V>>
		: never;

/** Extract the version union type from a KvDefinition */
export type InferKvVersionUnion<T> =
	T extends KvDefinition<infer V>
		? StandardSchemaV1.InferOutput<V[number]>
		: never;

// ════════════════════════════════════════════════════════════════════════════
// HELPER TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Type-safe table helper for a single static workspace table.
 *
 * Provides CRUD operations with schema validation and migration on read.
 * Backed by a YKeyValueLww store with row-level atomicity — `set()` replaces
 * the entire row, and partial updates are done via read-merge-write.
 *
 * ## Row Type
 *
 * `TRow` always extends `{ id: string }` and represents the latest schema
 * version's output type. Old rows are migrated to the latest schema on read.
 *
 * ## Difference from Dynamic API's TableHelper
 *
 * The static API uses row-level replacement (`set`) while the dynamic API has
 * cell-level LWW merge (`upsert`) and dedicated batch methods (`upsertMany`,
 * `deleteMany`). Batching in the static API is done at the workspace level
 * via `client.batch()`, which wraps `ydoc.transact()`.
 *
 * @typeParam TRow - The fully-typed row shape for this table (extends `{ id: string }`)
 */
export type TableHelper<TRow extends BaseRow> = {
	// ═══════════════════════════════════════════════════════════════════════
	// PARSE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Parse unknown input against the table schema and migrate to the latest version.
	 *
	 * Injects `id` into the input before validation. Does not write to storage.
	 * Useful for validating external data (imports, API payloads) before committing.
	 *
	 * @param id - The row ID to inject into the input
	 * @param input - Unknown data to validate against the table schema
	 * @returns `{ status: 'valid', row }` or `{ status: 'invalid', id, errors, row }`
	 */
	parse(id: string, input: unknown): RowResult<TRow>;

	// ═══════════════════════════════════════════════════════════════════════
	// WRITE (always writes latest schema shape)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Set a row (insert or replace). Always writes the full row.
	 *
	 * This is row-level atomic — the entire row is replaced in storage.
	 * There is no runtime validation on write; TypeScript enforces the shape.
	 *
	 * @param row - The complete row to write (must include `id`)
	 */
	set(row: TRow): void;

	// ═══════════════════════════════════════════════════════════════════════
	// READ (validates + migrates to latest)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Get a single row by ID.
	 *
	 * Returns a discriminated union:
	 * - `{ status: 'valid', row }` — Row exists and passes schema validation
	 * - `{ status: 'invalid', id, errors, row }` — Row exists but fails validation
	 * - `{ status: 'not_found', id, row: undefined }` — Row doesn't exist
	 *
	 * Old data is migrated to the latest schema version on read.
	 *
	 * @param id - The row ID to look up
	 */
	get(id: string): GetResult<TRow>;

	/**
	 * Get all rows with their validation status.
	 *
	 * Each result is either `{ status: 'valid', row }` or
	 * `{ status: 'invalid', id, errors, row }`. Old data is migrated on read.
	 */
	getAll(): RowResult<TRow>[];

	/**
	 * Get all rows that pass schema validation.
	 *
	 * Invalid rows are silently skipped. Use `getAllInvalid()` to inspect them.
	 */
	getAllValid(): TRow[];

	/**
	 * Get all rows that fail schema validation.
	 *
	 * Useful for debugging data corruption, schema drift, or incomplete migrations.
	 * Returns the raw row data alongside validation errors.
	 */
	getAllInvalid(): InvalidRowResult[];

	// ═══════════════════════════════════════════════════════════════════════
	// QUERY
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Filter valid rows by predicate.
	 *
	 * Invalid rows are silently skipped (never passed to the predicate).
	 *
	 * @param predicate - Function that returns `true` for rows to include
	 * @returns Array of matching valid rows
	 */
	filter(predicate: (row: TRow) => boolean): TRow[];

	/**
	 * Find the first valid row matching a predicate.
	 *
	 * Invalid rows are silently skipped. Returns `undefined` if no match found.
	 *
	 * @param predicate - Function that returns `true` for the desired row
	 * @returns The first matching valid row, or `undefined`
	 */
	find(predicate: (row: TRow) => boolean): TRow | undefined;

	// ═══════════════════════════════════════════════════════════════════════
	// UPDATE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Partial update a row by ID.
	 *
	 * Reads the current row, merges the partial fields, validates the merged
	 * result, and writes it back. Returns the updated row on success.
	 *
	 * @param id - The row ID to update
	 * @param partial - Fields to merge (all fields except `id` are optional)
	 * @returns `{ status: 'updated', row }`, or not_found/invalid if the merge fails
	 */
	update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow>;

	// ═══════════════════════════════════════════════════════════════════════
	// DELETE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Delete a single row by ID.
	 *
	 * If the row doesn't exist locally, returns `{ status: 'not_found_locally' }`.
	 *
	 * @param id - The row ID to delete
	 */
	delete(id: string): DeleteResult;

	/**
	 * Delete all rows from the table.
	 *
	 * The table structure is preserved — observers remain attached and the
	 * table helper continues to work after clearing. Only row data is removed.
	 */
	clear(): void;

	// ═══════════════════════════════════════════════════════════════════════
	// OBSERVE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Watch for row changes.
	 *
	 * The callback receives a `Set<string>` of row IDs that changed. To
	 * determine what happened, call `table.get(id)`:
	 * - `status === 'not_found'` → the row was deleted
	 * - Otherwise → the row was added or updated
	 *
	 * Changes are batched per Y.Transaction.
	 *
	 * @param callback - Receives changed IDs and the Y.Transaction
	 * @returns Unsubscribe function
	 */
	observe(
		callback: (changedIds: Set<string>, transaction: unknown) => void,
	): () => void;

	// ═══════════════════════════════════════════════════════════════════════
	// METADATA
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Get the total number of rows in the table.
	 *
	 * Includes both valid and invalid rows.
	 */
	count(): number;

	/**
	 * Check if a row exists by ID.
	 *
	 * @param id - The row ID to check
	 */
	has(id: string): boolean;
};

// ════════════════════════════════════════════════════════════════════════════
// AWARENESS TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Map of awareness field definitions. Each field has its own CombinedStandardSchema schema. */
export type AwarenessDefinitions = Record<string, CombinedStandardSchema>;

/** Extract the output type of an awareness field's schema. */
export type InferAwarenessValue<T> = T extends StandardSchemaV1
	? StandardSchemaV1.InferOutput<T>
	: never;

/**
 * The composed state type — all fields optional since peers may not have set every field.
 *
 * Each field's type is inferred from its StandardSchemaV1 schema. Fields are optional
 * because awareness is inherently partial — peers publish what they have.
 */
export type AwarenessState<TDefs extends AwarenessDefinitions> = {
	[K in keyof TDefs]?: InferAwarenessValue<TDefs[K]>;
};

/**
 * Helper for typed awareness access.
 * Wraps the raw y-protocols Awareness instance with schema-validated methods.
 *
 * Uses the record-of-fields pattern (same as tables and KV). Each field has its own
 * StandardSchemaV1 schema. When no fields are defined, `AwarenessHelper<Record<string, never>>`
 * has zero accessible field keys — methods exist but accept no valid arguments.
 *
 * @typeParam TDefs - Record of awareness field definitions (field name → StandardSchemaV1)
 */
export type AwarenessHelper<TDefs extends AwarenessDefinitions> = {
	/**
	 * Set this client's awareness state (merge into current state).
	 * Broadcasts to all connected peers via the awareness protocol.
	 * Accepts partial — only specified fields are set (merged into current state).
	 * No runtime validation — TypeScript catches type errors at compile time.
	 */
	setLocal(state: AwarenessState<TDefs>): void;

	/**
	 * Set a single awareness field.
	 * Maps directly to y-protocols setLocalStateField().
	 *
	 * @param key - The field name to set
	 * @param value - The value for the field (type-checked against the field's schema)
	 */
	setLocalField<K extends keyof TDefs & string>(
		key: K,
		value: InferAwarenessValue<TDefs[K]>,
	): void;

	/**
	 * Get this client's current awareness state.
	 * Returns null if not yet set.
	 */
	getLocal(): AwarenessState<TDefs> | null;

	/**
	 * Get a single local awareness field.
	 * Returns undefined if not set.
	 *
	 * @param key - The field name to get
	 * @returns The field value, or undefined if not set
	 */
	getLocalField<K extends keyof TDefs & string>(
		key: K,
	): InferAwarenessValue<TDefs[K]> | undefined;

	/**
	 * Get all connected clients' awareness states.
	 * Returns Map from Yjs clientID to validated state.
	 * Each field is independently validated against its schema.
	 * Invalid fields are omitted from the result (valid fields still included).
	 * Clients with zero valid fields are excluded entirely.
	 */
	getAll(): Map<number, AwarenessState<TDefs>>;

	/**
	 * Watch for awareness changes.
	 * Callback receives a map of clientIDs to change type.
	 * Returns unsubscribe function.
	 */
	observe(
		callback: (changes: Map<number, 'added' | 'updated' | 'removed'>) => void,
	): () => void;

	/**
	 * The raw y-protocols Awareness instance.
	 * Escape hatch for advanced use (custom heartbeats, direct protocol access).
	 * Pass to sync providers: createYjsProvider(ydoc, ..., { awareness: ctx.awareness.raw })
	 */
	raw: Awareness;
};

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Map of table definitions (uses `any` to allow variance in generic parameters) */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any, any>
>;

/** Map of KV definitions (uses `any` to allow variance in generic parameters) */
export type KvDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	KvDefinition<any>
>;

/** Tables helper object with all table helpers, including .docs when declared */
export type TablesHelper<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: TableHelper<
		InferTableRow<TTableDefinitions[K]>
	> &
		DocsPropertyOf<TTableDefinitions[K]>;
};

/** KV helper with dictionary-style access */
export type KvHelper<TKvDefinitions extends KvDefinitions> = {
	/** Get a value by key (validates + migrates). */
	get<K extends keyof TKvDefinitions & string>(
		key: K,
	): KvGetResult<InferKvValue<TKvDefinitions[K]>>;

	/** Set a value by key (always latest schema). */
	set<K extends keyof TKvDefinitions & string>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;

	/** Delete a value by key. */
	delete<K extends keyof TKvDefinitions & string>(key: K): void;

	/** Watch for changes to a key. Returns unsubscribe function. */
	observe<K extends keyof TKvDefinitions & string>(
		key: K,
		callback: (
			change: KvChange<InferKvValue<TKvDefinitions[K]>>,
			transaction: unknown,
		) => void,
	): () => void;
};

/**
 * Workspace definition created by defineWorkspace().
 *
 * This is a pure data structure for composability and type inference.
 * Pass to createWorkspace() to instantiate.
 */
export type WorkspaceDefinition<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
> = {
	id: TId;
	tables?: TTableDefinitions;
	kv?: TKvDefinitions;
	/** Record of awareness field schemas. Each field has its own StandardSchemaV1 schema. */
	awareness?: TAwarenessDefinitions;
};

/**
 * A workspace client with actions attached via `.withActions()`.
 *
 * This is an intersection of the base `WorkspaceClient` and `{ actions: TActions }`.
 * It is terminal — no more builder methods are available after `.withActions()`.
 */
export type WorkspaceClientWithActions<
	TId extends string,
	TTableDefs extends TableDefinitions,
	TKvDefs extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown>,
	TActions extends Actions,
> = WorkspaceClient<
	TId,
	TTableDefs,
	TKvDefs,
	TAwarenessDefinitions,
	TExtensions
> & {
	actions: TActions;
};

/**
 * Builder returned by `createWorkspace()` and by each `.withExtension()` call.
 *
 * IS a usable client AND has `.withExtension()` + `.withActions()`.
 *
 * ## Why `.withExtension()` is chainable (not a map)
 *
 * Extensions use chainable `.withExtension(key, factory)` calls instead of a single
 * `.withActions({...})` map for a key reason: **extensions build on each other progressively**.
 *
 * Each `.withExtension()` call returns a new builder where the next extension's factory
 * receives the accumulated extensions-so-far as typed context. This means extension N+1
 * can access extension N's exports. You may also be importing extensions you don't fully
 * control, and chaining lets you compose on top of them without modifying their source.
 *
 * Actions, by contrast, use a single `.withActions(factory)` call because:
 * - Actions are always defined by the app author (not imported from external packages)
 * - Actions don't build on each other — they all receive the same finalized client
 * - The ergonomic benefit of declaring all actions in one place outweighs chaining
 *
 * @example
 * ```typescript
 * const client = createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', ySweetSync({ auth: directAuth('...') }))
 *   .withActions((client) => ({
 *     createPost: defineMutation({ ... }),
 *   }));
 * ```
 */
export type WorkspaceClientBuilder<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown> = Record<string, never>,
	TDocExtKeys extends string = never,
> = WorkspaceClient<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	TExtensions
> & {
	/**
	 * Add a single extension. Returns a new builder with the extension's
	 * exports accumulated into the extensions type.
	 *
	 * Extensions are chained because they can build on each other progressively —
	 * each factory receives the client-so-far (including all previously added extensions)
	 * as typed context. This enables extension N+1 to access extension N's exports.
	 *
	 * The factory returns `{ exports?, lifecycle? }`.
	 * The framework normalizes defaults and stores `exports` by reference —
	 * getters and object identity are preserved.
	 *
	 * @param key - Unique name for this extension (used as the key in `.extensions`)
	 * @param factory - Factory function receiving the client-so-far context, returns Extension
	 * @returns A new builder with the extension's exports added to the type
	 *
	 * @example
	 * ```typescript
	 * const client = createWorkspace(definition)
	 *   .withExtension('persistence', ({ ydoc }) => {
	 *     const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	 *     return { lifecycle: { whenReady: idb.whenReady, destroy: () => idb.destroy() } };
	 *   })
	 *   .withExtension('sync', ({ extensions }) => {
	 *     // extensions.persistence is fully typed here!
	 *     return { exports: { provider }, lifecycle: { whenReady, destroy: () => provider.destroy() } };
	 *   });
	 * ```
	 */
	withExtension<TKey extends string, TExports extends Record<string, unknown>>(
		key: TKey,
		factory: (
			context: ExtensionContext<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				TAwarenessDefinitions,
				TExtensions
			>,
		) => Extension<TExports>,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions & Record<TKey, TExports>,
		TDocExtKeys
	>;

	/**
	 * Register a document extension that fires when content Y.Docs are opened
	 * via a table's document binding.
	 *
	 * Document extensions are separate from workspace extensions — they operate on
	 * content Y.Docs (not the workspace Y.Doc). Use optional `{ tags }` to target
	 * specific document types declared via `withDocument(..., { tags })`.
	 *
	 * If no `tags` option is provided, the extension is universal (fires for all content docs).
	 * If `tags` is provided, the extension fires only for documents whose tags share at
	 * least one value with the extension's tags (set intersection).
	 *
	 * @param key - Unique name for this document extension (independent namespace from workspace extensions)
	 * @param factory - Factory function receiving DocumentContext, returns DocumentLifecycle or void
	 * @param options - Optional tag filter for targeting specific document types
	 * @returns A new builder with the document extension key accumulated
	 *
	 * @example
	 * ```typescript
	 * createWorkspace({ id: 'app', tables: { notes } })
	 *   .withExtension('persistence', workspacePersistence)
	 *   .withDocumentExtension('persistence', ({ ydoc }) => {
	 *     const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	 *     return { whenReady: idb.whenSynced, destroy: () => idb.destroy() };
	 *   }, { tags: ['persistent'] })
	 * ```
	 */
	withDocumentExtension<K extends string>(
		key: K,
		factory: (context: DocumentContext) => DocumentLifecycle | void,
		options?: { tags?: ExtractAllDocTags<TTableDefinitions>[] },
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions,
		TDocExtKeys | K
	>;

	/**
	 * Attach actions to the workspace client. Terminal — no more chaining after this.
	 *
	 * Actions use a single map (not chaining) because they don't build on each other
	 * and are always defined by the app author. The ergonomic benefit of declaring
	 * all actions in one place outweighs the progressive composition that extensions need.
	 *
	 * @param factory - Receives the finalized client, returns an actions map
	 * @returns Client with actions attached (no more builder methods)
	 */
	withActions<TActions extends Actions>(
		factory: (
			client: WorkspaceClient<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				TAwarenessDefinitions,
				TExtensions
			>,
		) => TActions,
	): WorkspaceClientWithActions<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions,
		TActions
	>;
};

// Re-export Extension for convenience
export type { Extension } from '../shared/lifecycle.js';

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to extension factories — the "client-so-far".
 *
 * Each `.withExtension()` call passes the current `WorkspaceClient` to the factory.
 * The `extensions` field contains all previously added extensions, fully typed.
 * This enables progressive composition: extension N+1 can access extension N's exports.
 *
 * Includes `whenReady` (composite of all prior extensions' readiness), `destroy`,
 * and `definitions`, giving extensions full access to sequence after prior extensions
 * via `await context.whenReady`.
 *
 * @typeParam TId - Workspace identifier type
 * @typeParam TTableDefinitions - Map of table definitions for this workspace
 * @typeParam TKvDefinitions - Map of KV definitions for this workspace
 * @typeParam TAwarenessDefinitions - Map of awareness field definitions for this workspace
 * @typeParam TExtensions - Accumulated extension exports from previous `.withExtension()` calls
 *
 * @example
 * ```typescript
 * .withExtension('sync', (context) => {
 *   const provider = createProvider(context.ydoc, { awareness: context.awareness.raw });
 *   const whenReady = (async () => {
 *     await context.whenReady; // wait for all prior extensions (persistence, etc.)
 *     provider.connect();
 *   })();
 *   return { exports: { provider }, whenReady, destroy: () => provider.destroy() };
 * })
 * ```
 */
export type ExtensionContext<
	TId extends string = string,
	TTableDefinitions extends TableDefinitions = TableDefinitions,
	TKvDefinitions extends KvDefinitions = KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions = AwarenessDefinitions,
	TExtensions extends Record<string, unknown> = Record<string, unknown>,
> = WorkspaceClient<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	TExtensions
>;

/**
 * Factory function that creates an extension with lifecycle hooks.
 *
 * Returns a flat `{ exports?, whenReady?, destroy? }` object.
 * The framework normalizes defaults and stores `exports` by reference —
 * getters and object identity are preserved.
 *
 * @example Simple extension (works with any workspace)
 * ```typescript
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     exports: { provider },
 *     whenReady: provider.whenReady,
 *     destroy: () => provider.destroy(),
 *   };
 * };
 * ```
 *
 * @typeParam TExports - The consumer-facing exports object type
 */
export type ExtensionFactory<
	TExports extends Record<string, unknown> = Record<string, unknown>,
> = (context: ExtensionContext) => Extension<TExports>;

/** The workspace client returned by createWorkspace() */
export type WorkspaceClient<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown>,
> = {
	/** Workspace identifier */
	id: TId;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace definitions for introspection */
	definitions: {
		tables: TTableDefinitions;
		kv: TKvDefinitions;
		awareness: TAwarenessDefinitions;
	};
	/** Typed table helpers */
	tables: TablesHelper<TTableDefinitions>;
	/** Typed KV helper */
	kv: KvHelper<TKvDefinitions>;
	/** Typed awareness helper — always present, like tables and kv */
	awareness: AwarenessHelper<TAwarenessDefinitions>;
	/** Extension exports (accumulated via `.withExtension()` calls) */
	extensions: TExtensions;

	/**
	 * Execute multiple operations atomically in a single Y.js transaction.
	 *
	 * Groups all table and KV mutations inside the callback into one transaction.
	 * This means:
	 * - Observers fire once (not per-operation)
	 * - Creates a single undo/redo step
	 * - All changes are applied together
	 *
	 * The callback receives nothing because `tables` and `kv` are the same objects
	 * whether you're inside `batch()` or not — `ydoc.transact()` makes ALL operations
	 * on the shared doc atomic automatically. No special transactional wrapper needed.
	 *
	 * **Note**: Yjs transactions do NOT roll back on error. If the callback throws,
	 * any mutations that already executed within the callback are still applied.
	 *
	 * Nested `batch()` calls are safe — Yjs transact is reentrant, so inner calls
	 * are absorbed by the outer transaction.
	 *
	 * @param fn - Callback containing table/KV operations to batch
	 *
	 * @example Single table batching
	 * ```typescript
	 * client.batch(() => {
	 *   client.tables.posts.set({ id: '1', title: 'First' });
	 *   client.tables.posts.set({ id: '2', title: 'Second' });
	 *   client.tables.posts.delete('3');
	 * });
	 * // Observer fires once with all 3 changed IDs
	 * ```
	 *
	 * @example Cross-table + KV batching
	 * ```typescript
	 * client.batch(() => {
	 *   client.tables.tabs.set({ id: '1', url: 'https://...' });
	 *   client.tables.windows.set({ id: 'w1', name: 'Main' });
	 *   client.kv.set('lastSync', new Date().toISOString());
	 * });
	 * // All three writes are one atomic transaction
	 * ```
	 *
	 */
	batch(fn: () => void): void;

	/** Promise resolving when all extensions are ready */
	whenReady: Promise<void>;

	/** Cleanup all resources */
	destroy(): Promise<void>;

	/** Async dispose support */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Type alias for any workspace client (used for duck-typing in CLI/server).
 * Includes optional actions property since clients may or may not have actions attached.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly type
export type AnyWorkspaceClient = WorkspaceClient<any, any, any, any, any> & {
	actions?: Actions;
};
