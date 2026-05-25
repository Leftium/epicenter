/**
 * `attachTable()` — bind a TypeBox-native `TableDefinition` to a Y.Doc.
 *
 * Constructs an unencrypted `YKeyValueLww` on `ydoc.getArray('table:<name>')`
 * and wraps it with a typed `Table`. Provides CRUD operations with schema
 * validation and migration on read.
 *
 * For encrypted storage, call `encryption.attachTable` on the coordinator
 * returned by `attachEncryption(ydoc, { keyring })`.
 */

import {
	Type,
	type Static,
	type TLiteral,
	type TObject,
	type TOmit,
	type TPartial,
	type TSchema,
	type TUnion,
} from 'typebox';
import { Value } from 'typebox/value';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type * as Y from 'yjs';
import { TableKey } from './keys';
import {
	type KvStoreChangeHandler,
	type ObservableKvStore,
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from './y-keyvalue/index';

// ════════════════════════════════════════════════════════════════════════════
// TABLE PARSE ERROR
// ════════════════════════════════════════════════════════════════════════════

/**
 * Errors produced when parsing unknown input against a table's schema.
 *
 * Surfaced by `parse()`, `get()`, `getAll()`, and `update()`. "Not found"
 * on `get()` / `update()` is *not* an error: it's a legitimate absence and
 * is returned as `data: null` instead.
 */
export const TableParseError = defineErrors({
	/** The row's `_v` did not match any registered schema version. */
	UnknownVersion: ({ id, version }: { id: string; version: unknown }) => ({
		message: `Row '${id}' has unknown _v value: ${String(version)}`,
		id,
		version,
	}),
	/** TypeBox `Value.Check` rejected the row against the matched version. */
	ValidationFailed: ({
		id,
		errors,
		row,
	}: {
		id: string;
		errors: readonly { path: string; message: string }[];
		row: unknown;
	}) => ({
		message: `Row '${id}' failed schema validation: ${errors
			.map((e) => `${e.path}: ${e.message}`)
			.join('; ')}`,
		id,
		errors,
		row,
	}),
	/** The migration function threw while upgrading a valid-at-parse-time row. */
	MigrationFailed: ({ id, cause }: { id: string; cause: unknown }) => ({
		message: `Row '${id}' could not be migrated: ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
});
export type TableParseError = InferErrors<typeof TableParseError>;

// ════════════════════════════════════════════════════════════════════════════
// ROW TYPE
// ════════════════════════════════════════════════════════════════════════════

/**
 * The minimum shape every versioned table row must satisfy.
 *
 * `FlatJsonTSchema` rejects every TypeBox `~kind` whose `Static<>` is not
 * JSON-serializable, so the row's value-side stays JSON without needing a
 * `& JsonObject` intersection on this type.
 */
export type BaseRow = { id: string; _v: number };

// ════════════════════════════════════════════════════════════════════════════
// COLUMN RECORD TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A versioned column record. Every table version is a `Record<string,
 * TSchema>` carrying a string-ish `id` column and a `_v: column.literal(N)`
 * discriminant. `FlatJsonTSchema` (applied in `defineTable`'s parameter
 * type) enforces every column maps 1:1 to a SQLite column.
 */
export type VersionedColumns = {
	id: TSchema;
	_v: TLiteral<number>;
	[key: string]: TSchema;
};

/** Convert a column record to its row static type. */
export type RowOf<TCols extends Record<string, TSchema>> = {
	[K in keyof TCols]: Static<TCols[K]>;
};

/**
 * Distributive variant of `RowOf` over a tuple of versions. Each version's
 * row is computed independently and joined as a discriminated union, so
 * downstream `switch (row._v)` exhaustively narrows on the literal
 * discriminator.
 */
export type AnyVersionRow<TVersions extends readonly VersionedColumns[]> =
	TVersions extends readonly (infer V)[]
		? V extends VersionedColumns
			? RowOf<V>
			: never
		: never;

type LastVersion<TVersions extends readonly VersionedColumns[]> =
	TVersions extends readonly [...infer _, infer L]
		? L extends VersionedColumns
			? L
			: TVersions[number]
		: TVersions[number];

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION
// ════════════════════════════════════════════════════════════════════════════

/**
 * The reusable schema surfaces on every `TableDefinition`. Callers reach
 * for these directly: they should never need to walk `definition.versions`
 * for day-to-day code.
 */
export type TableSchema<TVersions extends readonly VersionedColumns[]> = {
	/** Current row TObject (latest version). */
	row: TObject<LastVersion<TVersions>>;
	/** Union of every version's row TObject. Used by parse-by-`_v`. */
	union: TUnion<TObject<VersionedColumns>[]>;
};

/**
 * Per-operation input schemas, mirrored on attached `Table` handles so
 * action authors can reuse them without reaching into `definition`.
 */
export type TableInput<TVersions extends readonly VersionedColumns[]> = {
	get: TObject<{ id: LastVersion<TVersions>['id'] }>;
	set: TObject<LastVersion<TVersions>>;
	update: TObject<{
		id: LastVersion<TVersions>['id'];
		patch: TPartial<TOmit<TObject<LastVersion<TVersions>>, ['id']>>;
	}>;
	delete: TObject<{ id: LastVersion<TVersions>['id'] }>;
};

/**
 * A table definition created by `defineTable(cols)` (single version) or
 * `defineTable(v1, v2, ...).migrate(fn)` (multi-version).
 *
 * For per-row content (rich text, long-form body), keep the row lean (ids,
 * metadata, a content-doc guid) and pair the table with a separate
 * `createDisposableCache(builder)` keyed on that content guid. Opening a row
 * then becomes `contentDocs.open(row.contentGuid)`: the list doesn't load
 * every content doc, and the editor doesn't contend with the table.
 */
export type TableDefinition<
	TVersions extends
		readonly VersionedColumns[] = readonly VersionedColumns[],
> = {
	/** The original variadic versions, in declaration order. */
	versions: TVersions;
	/** The latest version's column record. */
	columns: LastVersion<TVersions>;
	/** Reusable row/union TObject pair. */
	schema: TableSchema<TVersions>;
	/** Per-operation input schemas. */
	input: TableInput<TVersions>;
	/** Upgrade any stored version to the current row in one step. */
	migrate: (row: AnyVersionRow<TVersions>) => RowOf<LastVersion<TVersions>>;
};

/** Extract the row type from a TableDefinition (current version). */
export type InferTableRow<T> = T extends TableDefinition<infer TVersions>
	? TVersions extends readonly VersionedColumns[]
		? RowOf<LastVersion<TVersions>> & BaseRow
		: BaseRow
	: never;

/** Map of table definitions (uses `any` to allow variance in generic parameters). */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any>
>;

// ════════════════════════════════════════════════════════════════════════════
// createTableDefinition
// ════════════════════════════════════════════════════════════════════════════

/**
 * Internal helper: build a `TableDefinition` from a list of versions and the
 * migrate function. Called by `defineTable`; exposed for future codegen /
 * encryption helpers that need to assemble a definition directly.
 */
export function createTableDefinition<
	TVersions extends readonly VersionedColumns[],
>(
	versions: TVersions,
	migrate: (row: unknown) => RowOf<LastVersion<TVersions>>,
): TableDefinition<TVersions> {
	const latestColumns = versions[versions.length - 1] as LastVersion<TVersions>;
	const versionObjects = versions.map((cols) => Type.Object(cols));
	const row = Type.Object(latestColumns) as TObject<LastVersion<TVersions>>;
	const union = Type.Union(versionObjects) as TUnion<
		TObject<VersionedColumns>[]
	>;
	const idSchema = latestColumns.id as LastVersion<TVersions>['id'];
	const set = row;
	const get = Type.Object({ id: idSchema });
	const patch = Type.Partial(Type.Omit(row, ['id'])) as TPartial<
		TOmit<TObject<LastVersion<TVersions>>, ['id']>
	>;
	const update = Type.Object({ id: idSchema, patch });
	const deleteInput = Type.Object({ id: idSchema });

	return {
		versions,
		columns: latestColumns,
		schema: { row, union },
		input: {
			get: get as TableInput<TVersions>['get'],
			set,
			update: update as TableInput<TVersions>['update'],
			delete: deleteInput as TableInput<TVersions>['delete'],
		},
		migrate: migrate as TableDefinition<TVersions>['migrate'],
	};
}

// ════════════════════════════════════════════════════════════════════════════
// TABLE HANDLE TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Type-safe read-only runtime handle for a single workspace table.
 *
 * Mirrors `columns`, `schema`, and `input` from the definition so custom
 * actions can use the input schemas without reaching through `definition`.
 */
export type ReadonlyTable<
	TRow extends BaseRow,
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = {
	/** The table name (the Y.Array key this table is bound to). */
	name: string;

	/**
	 * The underlying `TableDefinition`. Exposed for introspection; most code
	 * prefers `columns` / `schema` / `input` mirrored directly on the handle.
	 */
	definition: TableDefinition<TVersions>;

	/** Latest version's column record. */
	columns: LastVersion<TVersions>;
	schema: TableSchema<TVersions>;
	input: TableInput<TVersions>;

	parse(id: string, input: unknown): Result<TRow, TableParseError>;
	get(id: string): Result<TRow | null, TableParseError>;
	getAll(): Array<Result<TRow, TableParseError>>;
	getAllValid(): TRow[];
	getAllInvalid(): TableParseError[];
	filter(predicate: (row: TRow) => boolean): TRow[];
	find(predicate: (row: TRow) => boolean): TRow | undefined;
	observe(
		callback: (changedIds: ReadonlySet<TRow['id']>, origin?: unknown) => void,
	): () => void;
	count(): number;
	has(id: string): boolean;
};

export type Table<
	TRow extends BaseRow,
	TVersions extends readonly VersionedColumns[] = readonly VersionedColumns[],
> = ReadonlyTable<TRow, TVersions> & {
	set(row: TRow): void;
	bulkSet(
		rows: TRow[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;
	update(
		id: string,
		partial: Partial<Omit<TRow, 'id'>>,
	): Result<TRow | null, TableParseError>;
	delete(id: string): void;
	bulkDelete(
		ids: string[],
		options?: {
			chunkSize?: number;
			onProgress?: (percent: number) => void;
		},
	): Promise<void>;
	clear(): void;
};

/** Map keyed by table name to Table for that table's row type. */
export type Tables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: Table<InferTableRow<TTableDefinitions[K]>>;
};

export type ReadonlyTables<TTableDefinitions extends TableDefinitions> = {
	[K in keyof TTableDefinitions]: ReadonlyTable<
		InferTableRow<TTableDefinitions[K]>
	>;
};

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC: attach
// ════════════════════════════════════════════════════════════════════════════

export function attachTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	name: string,
	definition: TTableDefinition,
): Table<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.once('destroy', () => ykv[Symbol.dispose]());
	return createTable(ykv, definition, name);
}

export function attachReadonlyTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ydoc: Y.Doc,
	name: string,
	definition: TTableDefinition,
): ReadonlyTable<InferTableRow<TTableDefinition>> {
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
	const ykv = new YKeyValueLww<unknown>(yarray);
	ydoc.once('destroy', () => ykv[Symbol.dispose]());
	return createReadonlyTable(ykv, definition, name);
}

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

export function attachReadonlyTables<T extends TableDefinitions>(
	ydoc: Y.Doc,
	definitions: T,
): ReadonlyTables<T> {
	return Object.fromEntries(
		Object.entries(definitions).map(([name, def]) => [
			name,
			attachReadonlyTable(ydoc, name, def),
		]),
	) as ReadonlyTables<T>;
}

// ════════════════════════════════════════════════════════════════════════════
// createTable / createReadonlyTable
// ════════════════════════════════════════════════════════════════════════════

export function createReadonlyTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): ReadonlyTable<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;

	const versions = definition.versions as readonly VersionedColumns[];
	const versionSchemas = new Map<number, TObject<VersionedColumns>>();
	for (const cols of versions) {
		const literalSchema = cols._v as TLiteral<number>;
		versionSchemas.set(
			literalSchema.const,
			Type.Object(cols) as TObject<VersionedColumns>,
		);
	}

	/**
	 * Parse and migrate a raw row value. Injects `id` into the input before
	 * validation, then routes by stored `_v` value to the matching schema.
	 * Lookup is value-based so `defineTable(v2, v1)` and `defineTable(v1, v2)`
	 * behave identically at read time.
	 */
	function parseRow(id: string, input: unknown): Result<TRow, TableParseError> {
		const row: Record<string, unknown> = {
			...(input as Record<string, unknown>),
			id,
		};
		const version = row._v;
		const schema =
			typeof version === 'number' ? versionSchemas.get(version) : undefined;
		if (!schema) {
			return TableParseError.UnknownVersion({ id, version });
		}
		if (!Value.Check(schema, row)) {
			const errors = [...Value.Errors(schema, row)].map((e) => ({
				path: e.instancePath,
				message: e.message,
			}));
			return TableParseError.ValidationFailed({ id, errors, row });
		}
		try {
			const migrated = definition.migrate(
				row as Parameters<typeof definition.migrate>[0],
			) as TRow;
			return Ok(migrated);
		} catch (cause) {
			return TableParseError.MigrationFailed({ id, cause });
		}
	}

	return {
		name,
		definition,
		columns: definition.columns,
		schema: definition.schema,
		input: definition.input,

		parse: parseRow,

		get(id: string): Result<TRow | null, TableParseError> {
			const raw = ykv.get(id);
			if (raw === undefined) return Ok(null);
			return parseRow(id, raw);
		},

		getAll(): Array<Result<TRow, TableParseError>> {
			const results: Array<Result<TRow, TableParseError>> = [];
			for (const [key, entry] of ykv.entries()) {
				results.push(parseRow(key, entry.val));
			}
			return results;
		},

		getAllValid(): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error) rows.push(data);
			}
			return rows;
		},

		getAllInvalid(): TableParseError[] {
			const invalid: TableParseError[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { error } = parseRow(key, entry.val);
				if (error) invalid.push(error);
			}
			return invalid;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const rows: TRow[] = [];
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error && predicate(data)) rows.push(data);
			}
			return rows;
		},

		find(predicate: (row: TRow) => boolean): TRow | undefined {
			for (const [key, entry] of ykv.entries()) {
				const { data, error } = parseRow(key, entry.val);
				if (!error && predicate(data)) return data;
			}
			return undefined;
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

export function createTable<
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly
	TTableDefinition extends TableDefinition<any>,
>(
	ykv: ObservableKvStore<unknown>,
	definition: TTableDefinition,
	name: string,
): Table<InferTableRow<TTableDefinition>> {
	type TRow = InferTableRow<TTableDefinition>;
	const readonly = createReadonlyTable(ykv, definition, name);

	return {
		...readonly,

		set(row: TRow): void {
			ykv.set(row.id, row);
		},

		async bulkSet(
			rows: TRow[],
			{
				chunkSize = 1000,
				onProgress,
			}: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			} = {},
		): Promise<void> {
			const total = rows.length;
			for (let i = 0; i < total; i += chunkSize) {
				const chunk = rows.slice(i, i + chunkSize);
				ykv.bulkSet(chunk.map((row) => ({ key: row.id, val: row })));
				onProgress?.(Math.min((i + chunkSize) / total, 1));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
		},

		update(
			id: string,
			partial: Partial<Omit<TRow, 'id'>>,
		): Result<TRow | null, TableParseError> {
			const { data: current, error: currentError } = readonly.get(id);
			if (currentError) return Err(currentError);
			if (current === null) return Ok(null);

			const merged = { ...current, ...partial, id };
			const { data: validated, error: mergedError } = readonly.parse(
				id,
				merged,
			);
			if (mergedError) return Err(mergedError);

			ykv.set(validated.id, validated);
			return Ok(validated);
		},

		delete(id: string): void {
			ykv.delete(id);
		},

		async bulkDelete(
			ids: string[],
			{
				chunkSize = 2500,
				onProgress,
			}: {
				chunkSize?: number;
				onProgress?: (percent: number) => void;
			} = {},
		): Promise<void> {
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
	};
}
