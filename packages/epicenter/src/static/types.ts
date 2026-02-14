/**
 * Shared types for the Static Workspace API.
 *
 * This module contains all type definitions for versioned tables and KV stores.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type { Extension } from '../shared/lifecycle.js';

// ════════════════════════════════════════════════════════════════════════════
// TABLE RESULT TYPES - Building Blocks
// ════════════════════════════════════════════════════════════════════════════

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

/** Extract the last element from a tuple, constrained to StandardSchemaV1 */
export type LastSchema<T extends readonly StandardSchemaV1[]> =
	T extends readonly [...StandardSchemaV1[], infer L extends StandardSchemaV1]
		? L
		: T[number];

/**
 * A table definition created by defineTable().version().migrate()
 *
 * @typeParam TVersions - Tuple of StandardSchemaV1 types representing all versions
 */
export type TableDefinition<TVersions extends readonly StandardSchemaV1[]> = {
	schema: StandardSchemaV1<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		row: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
};

/** Extract the row type from a TableDefinition */
export type InferTableRow<T> =
	T extends TableDefinition<infer V extends readonly StandardSchemaV1[]>
		? StandardSchemaV1.InferOutput<LastSchema<V>>
		: never;

/** Extract the version union type from a TableDefinition */
export type InferTableVersionUnion<T> =
	T extends TableDefinition<infer V extends readonly StandardSchemaV1[]>
		? StandardSchemaV1.InferOutput<V[number]>
		: never;

// ════════════════════════════════════════════════════════════════════════════
// KV DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A KV definition created by defineKv().version().migrate()
 *
 * @typeParam TVersions - Tuple of StandardSchemaV1 types representing all versions
 */
export type KvDefinition<TVersions extends readonly StandardSchemaV1[]> = {
	schema: StandardSchemaV1<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		value: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
};

/** Extract the value type from a KvDefinition */
export type InferKvValue<T> =
	T extends KvDefinition<infer V extends readonly StandardSchemaV1[]>
		? StandardSchemaV1.InferOutput<LastSchema<V>>
		: never;

/** Extract the version union type from a KvDefinition */
export type InferKvVersionUnion<T> =
	T extends KvDefinition<infer V extends readonly StandardSchemaV1[]>
		? StandardSchemaV1.InferOutput<V[number]>
		: never;

// ════════════════════════════════════════════════════════════════════════════
// HELPER TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Operations available inside a table batch transaction. */
export type TableBatchTransaction<TRow extends { id: string }> = {
	set(row: TRow): void;
	delete(id: string): void;
};

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
 * The static API uses row-level replacement (`set`) and a general `batch()`
 * transaction, while the dynamic API has cell-level LWW merge (`upsert`) and
 * dedicated batch methods (`upsertMany`, `deleteMany`). They share a common
 * core but diverge intentionally based on their storage models.
 *
 * @typeParam TRow - The fully-typed row shape for this table (extends `{ id: string }`)
 */
export type TableHelper<TRow extends { id: string }> = {
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
	// BATCH (Y.js transaction for atomicity)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Execute multiple operations atomically in a Y.js transaction.
	 *
	 * All changes inside the callback are applied as a single unit:
	 * - Single undo/redo step
	 * - Observers fire once (not per-operation)
	 * - All changes applied together or not at all
	 *
	 * @param fn - Callback receiving a transaction object with `set` and `delete`
	 *
	 * @example
	 * ```typescript
	 * table.batch((tx) => {
	 *   tx.set({ id: '1', title: 'First' });
	 *   tx.set({ id: '2', title: 'Second' });
	 *   tx.delete('3');
	 * });
	 * ```
	 */
	batch(fn: (tx: TableBatchTransaction<TRow>) => void): void;

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

/** Map of awareness field definitions. Each field has its own StandardSchemaV1 schema. */
export type AwarenessDefinitions = Record<string, StandardSchemaV1>;

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
	TableDefinition<any>
>;

/** Map of KV definitions (uses `any` to allow variance in generic parameters) */
export type KvDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	KvDefinition<any>
>;

/** Tables helper object with all table helpers */
export type TablesHelper<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: TableHelper<
		InferTableRow<TTableDefinitions[K]>
	>;
};

/** Operations available inside a KV batch transaction. */
export type KvBatchTransaction<TKvDefinitions extends KvDefinitions> = {
	set<K extends keyof TKvDefinitions & string>(
		key: K,
		value: InferKvValue<TKvDefinitions[K]>,
	): void;
	delete<K extends keyof TKvDefinitions & string>(key: K): void;
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

	/**
	 * Execute multiple operations atomically in a Y.js transaction.
	 */
	batch(fn: (tx: KvBatchTransaction<TKvDefinitions>) => void): void;

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
	 * The factory must return an `Extension` (from `defineExtension()`).
	 * The framework plucks `lifecycle` for internal management and stores
	 * `exports` by reference — getters and object identity are preserved.
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
	 *     return defineExtension({ whenReady: idb.whenReady, destroy: () => idb.destroy() });
	 *   })
	 *   .withExtension('sync', ({ extensions }) => {
	 *     // extensions.persistence is fully typed here!
	 *     return defineExtension({ ... });
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
		TExtensions & Record<TKey, TExports>
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
 *   return defineExtension({ exports: { provider }, whenReady, destroy: () => provider.destroy() });
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
 * All extensions MUST return an `Extension` (from `defineExtension()`).
 * The framework plucks `lifecycle` for internal management and stores
 * `exports` by reference — getters and object identity are preserved.
 *
 * Use `defineExtension()` from `shared/lifecycle.ts` to create the result:
 *
 * @example Simple extension (works with any workspace)
 * ```typescript
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return defineExtension({
 *     exports: { provider },
 *     whenReady: provider.whenReady,
 *     destroy: () => provider.destroy(),
 *   });
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
