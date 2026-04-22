/**
 * attachTable() — Bind a TableDefinition to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('table:<name>')`
 * and wraps it with a typed `Table`. Provides CRUD operations with
 * schema validation and migration on read.
 *
 * For encrypted storage, use `attachEncryptedTable` / `attachEncryptedKv`
 * from `@epicenter/workspace`.
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import { defineTable, attachTable } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * const posts = defineTable(type({ id: 'string', title: 'string', _v: '1' }));
 * const ydoc = new Y.Doc({ guid: 'my-doc' });
 * const postsTable = attachTable(ydoc, 'posts', posts);
 * postsTable.set({ id: '1', title: 'Hello', _v: 1 });
 * ```
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { JsonObject } from 'wellcrafted/json';
import type * as Y from 'yjs';
import { TableKey } from './keys.js';
import type { CombinedStandardSchema } from './standard-schema.js';
import {
	type KvStoreChangeHandler,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index.js';

// ════════════════════════════════════════════════════════════════════════════
// ROW RESULT TYPES
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
 * For per-row content (rich text, long-form body), keep the row lean (ids,
 * metadata, a content-doc guid) and pair the table with a separate
 * `defineDocument(builder)` factory keyed on that content guid. Opening a row
 * then becomes `contentDocs.open(row.contentGuid)` — the list doesn't load
 * every content doc, and the editor doesn't contend with the table.
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
 * Type-safe runtime handle for a single workspace table.
 *
 * Provides CRUD operations with schema validation and migration on read.
 *
 * @typeParam TRow - The fully-typed row shape for this table (extends `{ id: string }`)
 */
export type Table<TRow extends BaseRow> = {
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

/** Map keyed by table name to Table for that table's row type. */
export type Tables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Table<InferTableRow<TTableDefinitions[K]>>;
};

/**
 * Bind a single TableDefinition to a Y.Doc and return a typed Table.
 *
 * Creates (or reuses) a Y.Array at `table:<name>` and wraps it with an
 * unencrypted `YKeyValueLww` store.
 *
 * @param ydoc - The Y.Doc to attach to
 * @param name - The table name (used as the Y.Array key)
 * @param definition - The table definition with schema and migration
 */
export function attachTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	name: string,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.on('destroy', () => ykv.dispose());
	return createTable(ykv, definition);
}

/**
 * Bind a record of plaintext `TableDefinition`s to a Y.Doc. Sugar over
 * `attachTable` — calls it for each entry and returns the helpers keyed by
 * table name.
 *
 * For encrypted storage, use `attachEncryptedTables` from
 * `@epicenter/workspace`.
 */
export function attachTables<T extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: T,
): Tables<T> {
	return Object.fromEntries(
		Object.entries(definitions).map(([name, def]) => [
			name,
			attachTable(ydoc, name, def),
		]),
	) as Tables<T>;
}

/**
 * Construct a Table from any `ObservableKvStore` and a TableDefinition.
 *
 * Exported so `@epicenter/workspace` can reuse the exact same helper logic
 * over its encrypted store wrapper.
 */
export function createTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly — defineTable already constrains schemas
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;

	/**
	 * Parse and migrate a raw row value. Injects `id` into the input before validation.
	 */
	function parseRow(id: string, input: unknown): RowResult<TRow> {
		const row = { ...(input as Record<string, unknown>), id };
		const result = definition.schema['~standard'].validate(row);
		if (result instanceof Promise)
			throw new TypeError('Async schemas not supported');
		if (result.issues)
			return { status: 'invalid', id, errors: result.issues, row };
		const migrated = definition.migrate(result.value) as TRow;
		return { status: 'valid', row: migrated };
	}

	return {
		parse(id: string, input: unknown): RowResult<TRow> {
			return parseRow(id, input);
		},

		set(row: TRow): void {
			ykv.set(row.id, row);
		},

		async bulkSet(
			rows: TRow[],
			options?: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			},
		): Promise<void> {
			const { chunkSize = 1000, onProgress } = options ?? {};
			const total = rows.length;

			for (let i = 0; i < total; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize);
				ykv.bulkSet(chunk.map((row) => ({ key: row.id, val: row })));
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		update(id: string, partial: Partial<Omit<TRow, 'id'>>): UpdateResult<TRow> {
			const current = this.get(id);
			if (current.status !== 'valid') return current;

			const merged = { ...current.row, ...partial, id };
			const result = parseRow(id, merged);
			if (result.status === 'invalid') return result;

			this.set(result.row);
			return { status: 'updated', row: result.row };
		},

		get(id: string): GetResult<TRow> {
			const raw = ykv.get(id);
			if (raw === undefined) {
				return { status: 'not_found', id, row: undefined };
			}
			return parseRow(id, raw);
		},

		getAll(): RowResult<TRow>[] {
			const results: RowResult<TRow>[] = [];
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				results.push(result);
			}
			return results;
		},

		getAllValid(): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid') {
					rows.push(result.row);
				}
			}
			return rows;
		},

		getAllInvalid(): InvalidRowResult[] {
			const invalid: InvalidRowResult[] = [];
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'invalid') {
					invalid.push(result);
				}
			}
			return invalid;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					rows.push(result.row);
				}
			}
			return rows;
		},

		find(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const [key, entry] of ykv.entries()) {
				const result = parseRow(key, entry.val);
				if (result.status === 'valid' && predicate(result.row)) {
					return result.row;
				}
			}
			return undefined;
		},

		delete(id: string): void {
			ykv.delete(id);
		},

		async bulkDelete(
			ids: string[],
			options?: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			},
		): Promise<void> {
			const { chunkSize = 2500, onProgress } = options ?? {};
			const total = ids.length;

			for (let i = 0; i < total; i += chunkSize) {
				const chunk = ids.slice(i, i + chunkSize);
				ykv.bulkDelete(chunk);
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		clear(): void {
			const keys = Array.from(ykv.entries()).map(([k]) => k);
			ykv.bulkDelete(keys);
		},

		observe(
			callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
		): () => void {
			const handler: KvStoreChangeHandler<unknown> = (changes, origin) => {
				callback(new Set(changes.keys()) as ReadonlySet<TRow['id']>, origin);
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		count(): number {
			return ykv.size;
		},

		has(id: string): boolean {
			return ykv.has(id);
		},
	};
}
