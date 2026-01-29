import { Compile } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import * as Y from 'yjs';
import type { Field, PartialRow, Row, TableDefinitionMap } from '../schema';
import { fieldsToTypebox } from '../schema';

/**
 * A single validation error from TypeBox schema validation.
 *
 * Contains detailed information about why a row field failed validation,
 * including the JSON path to the invalid field, the expected schema,
 * and a human-readable error message.
 *
 * @example
 * ```typescript
 * const result = tables.get('posts').get({ id: '123' });
 * if (result.status === 'invalid') {
 *   for (const error of result.errors) {
 *     console.log(`${error.path}: ${error.message}`);
 *     // Output: "/title: Expected string"
 *   }
 * }
 * ```
 */
export type ValidationError = TLocalizedValidationError;

/** Y.Map storing cell values for a single row, keyed by column name. */
export type RowMap = Y.Map<unknown>;

/** Y.Map storing rows for a single table, keyed by row ID. */
export type TableMap = Y.Map<RowMap>;

/** Y.Map storing all tables, keyed by table name. */
export type TablesMap = Y.Map<TableMap>;

/** A row that passed validation. */
export type ValidRowResult<TRow> = { status: 'valid'; row: TRow };

/** A row that exists but failed validation. */
export type InvalidRowResult = {
	status: 'invalid';
	id: string;
	tableName: string;
	errors: ValidationError[];
	row: unknown;
};

/**
 * A row that was not found.
 * Includes `row: undefined` so row can always be destructured regardless of status.
 */
export type NotFoundResult = { status: 'not_found'; id: string; row: undefined };

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

/**
 * Result of updating a single row.
 *
 * Reflects Yjs semantics: update is a no-op if the row doesn't exist locally.
 * This is intentional - creating a row with partial fields could overwrite
 * a complete row from another peer via Last-Writer-Wins, causing data loss.
 */
export type UpdateResult =
	| { status: 'applied' }
	| { status: 'not_found_locally' };

/**
 * Result of updating multiple rows.
 *
 * - `all_applied`: Every row existed locally and was updated
 * - `partially_applied`: Some rows were updated, others weren't found locally
 * - `none_applied`: No rows were found locally (nothing was updated)
 */
export type UpdateManyResult =
	| { status: 'all_applied'; applied: string[] }
	| {
			status: 'partially_applied';
			applied: string[];
			notFoundLocally: string[];
	  }
	| { status: 'none_applied'; notFoundLocally: string[] };

/**
 * Result of deleting a single row.
 *
 * Reflects Yjs semantics: deleting a non-existent key is a no-op.
 * No operation is recorded, so the delete won't propagate to other peers.
 * You cannot "pre-delete" something that hasn't synced yet.
 */
export type DeleteResult =
	| { status: 'deleted' }
	| { status: 'not_found_locally' };

/**
 * Result of deleting multiple rows.
 *
 * - `all_deleted`: Every row existed locally and was deleted
 * - `partially_deleted`: Some rows were deleted, others weren't found locally
 * - `none_deleted`: No rows were found locally (nothing was deleted)
 */
export type DeleteManyResult =
	| { status: 'all_deleted'; deleted: string[] }
	| {
			status: 'partially_deleted';
			deleted: string[];
			notFoundLocally: string[];
	  }
	| { status: 'none_deleted'; notFoundLocally: string[] };

/**
 * Set of row IDs that changed.
 *
 * The observer tells you WHICH rows changed. To know what happened:
 * - Call `table.get(id)` to get current state
 * - If `not_found`, the row was deleted
 * - Otherwise, the row was added or updated (use your own tracking if you need to distinguish)
 *
 * This simple contract avoids semantic complexity around action classification
 * and lets callers decide how to handle changes.
 */
export type ChangedRowIds = Set<string>;

/**
 * @deprecated Use ChangedRowIds (Set<string>) instead. RowAction is no longer tracked.
 */
export type RowAction = 'add' | 'update' | 'delete';

/**
 * @deprecated Use ChangedRowIds (Set<string>) instead. The new observe() returns just IDs.
 */
export type RowChanges = Map<string, RowAction>;

/**
 * Creates a type-safe collection of table helpers for all tables in a definition.
 */
export function createTableHelpers<
	TTableDefinitionMap extends TableDefinitionMap,
>({
	ydoc,
	tableDefinitions,
}: {
	ydoc: Y.Doc;
	tableDefinitions: TTableDefinitionMap;
}) {
	const ytables: TablesMap = ydoc.getMap('tables');

	return Object.fromEntries(
		Object.entries(tableDefinitions).map(([tableName, tableDefinition]) => {
			return [
				tableName,
				createTableHelper({
					ydoc,
					tableName,
					ytables,
					fields: tableDefinition.fields,
				}),
			];
		}),
	) as {
		[TTableName in keyof TTableDefinitionMap]: TableHelper<
			TTableDefinitionMap[TTableName]['fields']
		>;
	};
}

/**
 * Creates a single table helper with type-safe CRUD operations.
 *
 * ## Storage Architecture (Cell-Level CRDT Merging)
 *
 * Each table is a Y.Map<rowId, RowMap> where each row is a Y.Map<columnName, value>.
 * This enables concurrent edits to different columns to merge correctly:
 *
 * ```
 * User A edits title, User B edits views → After sync: both changes preserved
 * ```
 */
function createTableHelper<TFields extends readonly Field[]>({
	ydoc,
	tableName,
	ytables,
	fields,
}: {
	ydoc: Y.Doc;
	tableName: string;
	ytables: TablesMap;
	fields: TFields;
}) {
	type TRow = Row<TFields> & { id: string };

	const typeboxSchema = fieldsToTypebox(fields);
	const rowValidator = Compile(typeboxSchema);

	/**
	 * Get the Y.Map for this table if it exists, or null if not.
	 *
	 * Used by read operations that should NOT create the table if it doesn't exist.
	 * This is critical for sync: if we create an empty table before sync happens,
	 * it will conflict with the synced table from another peer.
	 */
	const getExistingTableMap = (): TableMap | null => {
		return ytables.get(tableName) ?? null;
	};

	/**
	 * Get or lazily create the Y.Map for this table.
	 *
	 * Tables are stored as nested Y.Maps: `ytables.get(tableName)` returns
	 * the table-level Y.Map that holds all rows (keyed by row ID).
	 *
	 * ONLY use this in write operations (upsert, delete, clear).
	 * Read operations should use getExistingTableMap() to avoid
	 * creating conflicting Y.Maps before sync completes.
	 */
	const getOrCreateTableMap = (): TableMap => {
		let tableMap = ytables.get(tableName);
		if (!tableMap) {
			tableMap = new Y.Map() as TableMap;
			ytables.set(tableName, tableMap);
		}
		return tableMap;
	};

	/**
	 * Get or create a row Y.Map, creating the row if needed.
	 *
	 * Use this for upsert operations that always need a row to exist.
	 * Creates the row Y.Map if it doesn't exist.
	 *
	 * @example
	 * ```typescript
	 * const rowMap = getOrCreateRow('post-123');
	 * rowMap.set('title', 'Hello World'); // Always succeeds
	 * ```
	 */
	const getOrCreateRow = (rowId: string): RowMap => {
		const tableMap = getOrCreateTableMap();
		let rowMap = tableMap.get(rowId);
		if (!rowMap) {
			rowMap = new Y.Map() as RowMap;
			tableMap.set(rowId, rowMap);
		}
		return rowMap;
	};

	/**
	 * Get the Y.Map for an existing row, or null if not found.
	 *
	 * Use this for read/update operations that need to handle missing rows.
	 * Returns null if the row doesn't exist.
	 *
	 * @example
	 * ```typescript
	 * const rowMap = getRow('post-123');
	 * if (!rowMap) return { status: 'not_found', id: 'post-123' };
	 * ```
	 */
	const getRow = (rowId: string): RowMap | null => {
		const tableMap = getExistingTableMap();
		if (!tableMap) return null;
		return tableMap.get(rowId) ?? null;
	};

	/**
	 * Reconstruct a row object from a Y.Map.
	 *
	 * Returns `Record<string, unknown>` because we know it's an object with
	 * string keys, but values are unvalidated. Use `validateRow()` to get
	 * a typed `RowResult<TRow>` with validation status.
	 */
	const reconstructRow = (rowMap: RowMap): Record<string, unknown> => {
		const row: Record<string, unknown> = {};
		for (const [key, value] of rowMap.entries()) {
			row[key] = value;
		}
		return row;
	};

	/**
	 * Validate a reconstructed row against the table schema.
	 *
	 * Centralizes validation logic used by get(), getAll(), getAllInvalid(),
	 * and observe(). Returns a discriminated union so callers can
	 * handle valid and invalid rows uniformly.
	 */
	const validateRow = (
		id: string,
		row: Record<string, unknown>,
	): RowResult<TRow> => {
		if (rowValidator.Check(row)) {
			return { status: 'valid', row: row as TRow };
		}
		return {
			status: 'invalid',
			id,
			tableName,
			errors: rowValidator.Errors(row),
			row,
		};
	};

	return {
		update(partialRow: PartialRow<TFields>): UpdateResult {
			const rowMap = getRow(partialRow.id);
			if (!rowMap) return { status: 'not_found_locally' };

			ydoc.transact(() => {
				for (const [key, value] of Object.entries(partialRow)) {
					rowMap.set(key, value);
				}
			});

			return { status: 'applied' };
		},

		upsert(rowData: TRow): void {
			ydoc.transact(() => {
				const rowMap = getOrCreateRow(rowData.id);
				for (const [key, value] of Object.entries(rowData)) {
					rowMap.set(key, value);
				}
			});
		},

		upsertMany(rows: TRow[]): void {
			ydoc.transact(() => {
				for (const rowData of rows) {
					const rowMap = getOrCreateRow(rowData.id);
					for (const [key, value] of Object.entries(rowData)) {
						rowMap.set(key, value);
					}
				}
			});
		},

		updateMany(rows: PartialRow<TFields>[]): UpdateManyResult {
			const applied: string[] = [];
			const notFoundLocally: string[] = [];

			ydoc.transact(() => {
				for (const partialRow of rows) {
					const rowMap = getRow(partialRow.id);
					if (!rowMap) {
						notFoundLocally.push(partialRow.id);
						continue;
					}
					for (const [key, value] of Object.entries(partialRow)) {
						rowMap.set(key, value);
					}
					applied.push(partialRow.id);
				}
			});

			if (notFoundLocally.length === 0)
				return { status: 'all_applied', applied };
			if (applied.length === 0)
				return { status: 'none_applied', notFoundLocally };
			return { status: 'partially_applied', applied, notFoundLocally };
		},

		get(id: string): GetResult<TRow> {
			const rowMap = getRow(id);
			if (!rowMap) return { status: 'not_found', id, row: undefined };
			return validateRow(id, reconstructRow(rowMap));
		},

		getAll(): RowResult<TRow>[] {
			const tableMap = getExistingTableMap();
			if (!tableMap) return [];

			const results: RowResult<TRow>[] = [];
			for (const [id, rowMap] of tableMap.entries()) {
				results.push(validateRow(id, reconstructRow(rowMap)));
			}
			return results;
		},

		getAllValid(): TRow[] {
			const tableMap = getExistingTableMap();
			if (!tableMap) return [];

			const result: TRow[] = [];

			for (const [_id, rowMap] of tableMap.entries()) {
				const row = reconstructRow(rowMap);
				if (rowValidator.Check(row)) {
					result.push(row as TRow);
				}
			}

			return result;
		},

		getAllInvalid(): InvalidRowResult[] {
			const tableMap = getExistingTableMap();
			if (!tableMap) return [];

			const result: InvalidRowResult[] = [];
			for (const [id, rowMap] of tableMap.entries()) {
				const validated = validateRow(id, reconstructRow(rowMap));
				if (validated.status === 'invalid') {
					result.push(validated);
				}
			}
			return result;
		},

		has(id: string): boolean {
			const tableMap = getExistingTableMap();
			return tableMap?.has(id) ?? false;
		},

		delete(id: string): DeleteResult {
			const tableMap = getExistingTableMap();
			if (!tableMap || !tableMap.has(id))
				return { status: 'not_found_locally' };

			tableMap.delete(id);
			return { status: 'deleted' };
		},

		deleteMany(ids: string[]): DeleteManyResult {
			const tableMap = getExistingTableMap();
			if (!tableMap) {
				return { status: 'none_deleted', notFoundLocally: ids };
			}

			const deleted: string[] = [];
			const notFoundLocally: string[] = [];

			ydoc.transact(() => {
				for (const id of ids) {
					if (tableMap.has(id)) {
						tableMap.delete(id);
						deleted.push(id);
					} else {
						notFoundLocally.push(id);
					}
				}
			});

			if (notFoundLocally.length === 0)
				return { status: 'all_deleted', deleted };
			if (deleted.length === 0)
				return { status: 'none_deleted', notFoundLocally };
			return { status: 'partially_deleted', deleted, notFoundLocally };
		},

		/**
		 * Delete all rows from the table.
		 *
		 * ## Design: Tables Are Never Deleted
		 *
		 * This method deletes all rows within the table, but the table's Y.Map
		 * structure itself is preserved. Tables defined in your definition are permanent;
		 * they can be emptied but never removed.
		 *
		 * This design ensures:
		 * - Observers remain attached (no need to re-observe after clearing)
		 * - `tables.get('posts')` always returns a valid helper
		 * - No edge cases around table deletion/recreation during sync
		 *
		 * If you need to "reset" a table, call `clear()`. The table structure
		 * persists, ready for new rows.
		 */
		clear(): void {
			const tableMap = getExistingTableMap();
			if (!tableMap) return;

			ydoc.transact(() => {
				for (const id of tableMap.keys()) {
					tableMap.delete(id);
				}
			});
		},

		count(): number {
			const tableMap = getExistingTableMap();
			return tableMap?.size ?? 0;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const tableMap = getExistingTableMap();
			if (!tableMap) return [];

			const result: TRow[] = [];

			for (const [_id, rowMap] of tableMap.entries()) {
				const row = reconstructRow(rowMap);
				if (rowValidator.Check(row)) {
					const validRow = row as TRow;
					if (predicate(validRow)) {
						result.push(validRow);
					}
				}
			}

			return result;
		},

		find(predicate: (row: TRow) => boolean): TRow | null {
			const tableMap = getExistingTableMap();
			if (!tableMap) return null;

			for (const [_id, rowMap] of tableMap.entries()) {
				const row = reconstructRow(rowMap);
				if (rowValidator.Check(row)) {
					const validRow = row as TRow;
					if (predicate(validRow)) {
						return validRow;
					}
				}
			}

			return null;
		},

		/**
		 * Watch for row changes.
		 *
		 * ## Simple Contract
		 *
		 * The callback receives a Set of row IDs that changed. To determine what happened:
		 * - Call `table.get(id)` to get the current state
		 * - If `status === 'not_found'`, the row was deleted
		 * - Otherwise, the row was added or updated
		 *
		 * This intentionally does NOT distinguish between add and update. If you need
		 * that distinction, track row existence yourself before/after changes.
		 *
		 * ## Transaction Batching
		 *
		 * Changes are batched per Y.Transaction. `upsertMany(1000)` fires ONE callback
		 * with 1000 IDs, not 1000 callbacks.
		 *
		 * ## Deduplication
		 *
		 * If a row changes multiple times in one transaction, it appears once in the Set.
		 *
		 * ## Y.Text and Nested Changes
		 *
		 * Changes to Y.Text fields (or any nested Y.AbstractType) are automatically
		 * detected and included. No special handling needed.
		 *
		 * @returns Unsubscribe function
		 *
		 * @example
		 * ```typescript
		 * const unsubscribe = table.observe((changedIds, transaction) => {
		 *   for (const id of changedIds) {
		 *     const result = table.get(id);
		 *     if (result.status === 'not_found') {
		 *       console.log('Deleted:', id);
		 *     } else if (result.status === 'valid') {
		 *       console.log('Added/Updated:', result.row);
		 *     }
		 *   }
		 * });
		 * ```
		 */
		observe(
			callback: (changedIds: ChangedRowIds, transaction: Y.Transaction) => void,
		): () => void {
			let tableMap = getExistingTableMap();

			const handler = (
				events: Y.YEvent<Y.Map<unknown>>[],
				transaction: Y.Transaction,
			) => {
				const changedIds = new Set<string>();

				for (const event of events) {
					if (event.target === tableMap) {
						// Table-level event: row added or deleted
						for (const rowId of event.changes.keys.keys()) {
							changedIds.add(rowId);
						}
					} else {
						// Nested event: cell change or Y.Text edit
						// event.path[0] is the rowId for nested events
						const rowId = event.path[0];
						if (typeof rowId === 'string') {
							changedIds.add(rowId);
						}
					}
				}

				if (changedIds.size > 0) {
					callback(changedIds, transaction);
				}
			};

			// If table already exists, start observing it
			if (tableMap) {
				tableMap.observeDeep(handler);
			}

			// Watch for table creation/replacement at the ytables level
			const ytablesHandler = (event: Y.YMapEvent<TableMap>) => {
				for (const [key, change] of event.changes.keys) {
					if (key !== tableName) continue;

					if (change.action === 'add' || change.action === 'update') {
						const newTableMap = ytables.get(tableName);
						if (newTableMap && newTableMap !== tableMap) {
							// Unobserve old table if it existed
							if (tableMap) {
								tableMap.unobserveDeep(handler);
							}
							tableMap = newTableMap;
							tableMap.observeDeep(handler);

							// Fire callback for all rows in the new/replaced table
							const changedIds = new Set<string>();
							for (const rowId of tableMap.keys()) {
								changedIds.add(rowId);
							}
							if (changedIds.size > 0) {
								callback(changedIds, event.transaction);
							}
						}
					} else if (change.action === 'delete') {
						if (tableMap) {
							// Fire callback for all deleted rows before unobserving
							const changedIds = new Set<string>();
							for (const rowId of tableMap.keys()) {
								changedIds.add(rowId);
							}
							tableMap.unobserveDeep(handler);
							tableMap = null;
							if (changedIds.size > 0) {
								callback(changedIds, event.transaction);
							}
						}
					}
				}
			};

			ytables.observe(ytablesHandler);

			return () => {
				if (tableMap) {
					tableMap.unobserveDeep(handler);
				}
				ytables.unobserve(ytablesHandler);
			};
		},

		/**
		 * Type inference helper for the row type.
		 *
		 * @example
		 * ```typescript
		 * type PostRow = typeof tables.get('posts').inferRow;
		 * ```
		 */
		inferRow: null as unknown as TRow,
	};
}

export type TableHelper<TFields extends readonly Field[]> = ReturnType<
	typeof createTableHelper<TFields>
>;

/**
 * A table helper for dynamically-created tables without a definition.
 * No validation is performed; all rows are treated as `Record<string, unknown> & { id: string }`.
 */
export type UntypedTableHelper = {
	update(partialRow: { id: string } & Record<string, unknown>): UpdateResult;
	upsert(rowData: { id: string } & Record<string, unknown>): void;
	upsertMany(rows: ({ id: string } & Record<string, unknown>)[]): void;
	updateMany(
		rows: ({ id: string } & Record<string, unknown>)[],
	): UpdateManyResult;
	get(id: string): GetResult<{ id: string } & Record<string, unknown>>;
	getAll(): RowResult<{ id: string } & Record<string, unknown>>[];
	getAllValid(): ({ id: string } & Record<string, unknown>)[];
	getAllInvalid(): InvalidRowResult[];
	has(id: string): boolean;
	delete(id: string): DeleteResult;
	deleteMany(ids: string[]): DeleteManyResult;
	/**
	 * Delete all rows from the table.
	 *
	 * Tables are permanent structures; they can be emptied but never removed.
	 * Observers remain attached after clearing.
	 */
	clear(): void;
	count(): number;
	filter(
		predicate: (row: { id: string } & Record<string, unknown>) => boolean,
	): ({ id: string } & Record<string, unknown>)[];
	find(
		predicate: (row: { id: string } & Record<string, unknown>) => boolean,
	): ({ id: string } & Record<string, unknown>) | null;
	observe(
		callback: (changedIds: ChangedRowIds, transaction: Y.Transaction) => void,
	): () => void;
	inferRow: { id: string } & Record<string, unknown>;
	/** Access the underlying Y.Map for advanced use cases */
	readonly raw: TableMap;
};

/**
 * Creates a table helper for a dynamic/undefined table (no field schema validation).
 *
 * Used by `tables.table(name)` when accessing a table that isn't in the
 * workspace definition. All rows are typed as `{ id: string } & Record<string, unknown>`
 * and no validation is performed.
 */
export function createUntypedTableHelper({
	ydoc,
	tableName,
	ytables,
}: {
	ydoc: Y.Doc;
	tableName: string;
	ytables: TablesMap;
}): UntypedTableHelper {
	type TRow = { id: string } & Record<string, unknown>;

	const getExistingTableMap = (): TableMap | null => {
		return ytables.get(tableName) ?? null;
	};

	const getOrCreateTableMap = (): TableMap => {
		let tableMap = ytables.get(tableName);
		if (!tableMap) {
			tableMap = new Y.Map() as TableMap;
			ytables.set(tableName, tableMap);
		}
		return tableMap;
	};

	const getOrCreateRow = (rowId: string): RowMap => {
		const tableMap = getOrCreateTableMap();
		let rowMap = tableMap.get(rowId);
		if (!rowMap) {
			rowMap = new Y.Map() as RowMap;
			tableMap.set(rowId, rowMap);
		}
		return rowMap;
	};

	const getRow = (rowId: string): RowMap | null => {
		const tableMap = getExistingTableMap();
		if (!tableMap) return null;
		return tableMap.get(rowId) ?? null;
	};

	const reconstructRow = (rowMap: RowMap): Record<string, unknown> => {
		const row: Record<string, unknown> = {};
		for (const [key, value] of rowMap.entries()) {
			row[key] = value;
		}
		return row;
	};

	return {
		update(partialRow: TRow): UpdateResult {
			const rowMap = getRow(partialRow.id);
			if (!rowMap) return { status: 'not_found_locally' };

			ydoc.transact(() => {
				for (const [key, value] of Object.entries(partialRow)) {
					rowMap.set(key, value);
				}
			});

			return { status: 'applied' };
		},

		upsert(rowData: TRow): void {
			ydoc.transact(() => {
				const rowMap = getOrCreateRow(rowData.id);
				for (const [key, value] of Object.entries(rowData)) {
					rowMap.set(key, value);
				}
			});
		},

		upsertMany(rows: TRow[]): void {
			ydoc.transact(() => {
				for (const rowData of rows) {
					const rowMap = getOrCreateRow(rowData.id);
					for (const [key, value] of Object.entries(rowData)) {
						rowMap.set(key, value);
					}
				}
			});
		},

		updateMany(rows: TRow[]): UpdateManyResult {
			const applied: string[] = [];
			const notFoundLocally: string[] = [];

			ydoc.transact(() => {
				for (const partialRow of rows) {
					const rowMap = getRow(partialRow.id);
					if (!rowMap) {
						notFoundLocally.push(partialRow.id);
						continue;
					}
					for (const [key, value] of Object.entries(partialRow)) {
						rowMap.set(key, value);
					}
					applied.push(partialRow.id);
				}
			});

			if (notFoundLocally.length === 0)
				return { status: 'all_applied', applied };
			if (applied.length === 0)
				return { status: 'none_applied', notFoundLocally };
			return { status: 'partially_applied', applied, notFoundLocally };
		},

		get(id: string): GetResult<TRow> {
			const rowMap = getRow(id);
			if (!rowMap) return { status: 'not_found', id, row: undefined };
			const row = reconstructRow(rowMap);
			return { status: 'valid', row: row as TRow };
		},

		getAll(): RowResult<TRow>[] {
			const tableMap = getExistingTableMap();
			if (!tableMap) return [];

			const results: RowResult<TRow>[] = [];
			for (const [_id, rowMap] of tableMap.entries()) {
				const row = reconstructRow(rowMap);
				results.push({ status: 'valid', row: row as TRow });
			}
			return results;
		},

		getAllValid(): TRow[] {
			const tableMap = getExistingTableMap();
			if (!tableMap) return [];

			const result: TRow[] = [];
			for (const [_id, rowMap] of tableMap.entries()) {
				result.push(reconstructRow(rowMap) as TRow);
			}
			return result;
		},

		getAllInvalid(): InvalidRowResult[] {
			return [];
		},

		has(id: string): boolean {
			const tableMap = getExistingTableMap();
			return tableMap?.has(id) ?? false;
		},

		delete(id: string): DeleteResult {
			const tableMap = getExistingTableMap();
			if (!tableMap || !tableMap.has(id))
				return { status: 'not_found_locally' };

			tableMap.delete(id);
			return { status: 'deleted' };
		},

		deleteMany(ids: string[]): DeleteManyResult {
			const tableMap = getExistingTableMap();
			if (!tableMap) {
				return { status: 'none_deleted', notFoundLocally: ids };
			}

			const deleted: string[] = [];
			const notFoundLocally: string[] = [];

			ydoc.transact(() => {
				for (const id of ids) {
					if (tableMap.has(id)) {
						tableMap.delete(id);
						deleted.push(id);
					} else {
						notFoundLocally.push(id);
					}
				}
			});

			if (notFoundLocally.length === 0)
				return { status: 'all_deleted', deleted };
			if (deleted.length === 0)
				return { status: 'none_deleted', notFoundLocally };
			return { status: 'partially_deleted', deleted, notFoundLocally };
		},

		/**
		 * Delete all rows from the table.
		 *
		 * ## Design: Tables Are Never Deleted
		 *
		 * This method deletes all rows within the table, but the table's Y.Map
		 * structure itself is preserved. Tables defined in your definition are permanent;
		 * they can be emptied but never removed.
		 *
		 * This design ensures:
		 * - Observers remain attached (no need to re-observe after clearing)
		 * - `tables.get('posts')` always returns a valid helper
		 * - No edge cases around table deletion/recreation during sync
		 *
		 * If you need to "reset" a table, call `clear()`. The table structure
		 * persists, ready for new rows.
		 */
		clear(): void {
			const tableMap = getExistingTableMap();
			if (!tableMap) return;

			ydoc.transact(() => {
				for (const id of tableMap.keys()) {
					tableMap.delete(id);
				}
			});
		},

		count(): number {
			const tableMap = getExistingTableMap();
			return tableMap?.size ?? 0;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const tableMap = getExistingTableMap();
			if (!tableMap) return [];

			const result: TRow[] = [];
			for (const [_id, rowMap] of tableMap.entries()) {
				const row = reconstructRow(rowMap) as TRow;
				if (predicate(row)) {
					result.push(row);
				}
			}
			return result;
		},

		find(predicate: (row: TRow) => boolean): TRow | null {
			const tableMap = getExistingTableMap();
			if (!tableMap) return null;

			for (const [_id, rowMap] of tableMap.entries()) {
				const row = reconstructRow(rowMap) as TRow;
				if (predicate(row)) {
					return row;
				}
			}
			return null;
		},

		observe(
			callback: (changedIds: ChangedRowIds, transaction: Y.Transaction) => void,
		): () => void {
			let tableMap = getExistingTableMap();

			const handler = (
				events: Y.YEvent<Y.Map<unknown>>[],
				transaction: Y.Transaction,
			) => {
				const changedIds = new Set<string>();

				for (const event of events) {
					if (event.target === tableMap) {
						// Table-level event: row added or deleted
						for (const rowId of event.changes.keys.keys()) {
							changedIds.add(rowId);
						}
					} else {
						// Nested event: cell change or Y.Text edit
						const rowId = event.path[0];
						if (typeof rowId === 'string') {
							changedIds.add(rowId);
						}
					}
				}

				if (changedIds.size > 0) {
					callback(changedIds, transaction);
				}
			};

			// If table already exists, start observing it
			if (tableMap) {
				tableMap.observeDeep(handler);
			}

			// Watch for table creation at the ytables level (lazy creation on first write).
			// Tables are never deleted or replaced; this only handles initial creation.
			const ytablesHandler = (event: Y.YMapEvent<TableMap>) => {
				for (const [key, change] of event.changes.keys) {
					if (key !== tableName) continue;

					if (change.action === 'add' && !tableMap) {
						// Table was lazily created on first write
						const newTableMap = ytables.get(tableName);
						if (newTableMap) {
							tableMap = newTableMap;
							tableMap.observeDeep(handler);

							// Fire callback for all rows in the newly created table
							const changedIds = new Set<string>();
							for (const rowId of tableMap.keys()) {
								changedIds.add(rowId);
							}
							if (changedIds.size > 0) {
								callback(changedIds, event.transaction);
							}
						}
					}
					// Note: We intentionally don't handle 'delete' or 'update' (table replacement).
					// Tables are permanent structures; use clear() to empty a table.
				}
			};

			ytables.observe(ytablesHandler);

			return () => {
				if (tableMap) {
					tableMap.unobserveDeep(handler);
				}
				ytables.unobserve(ytablesHandler);
			};
		},

		get raw(): TableMap {
			return getOrCreateTableMap();
		},

		/**
		 * Type inference helper for the row type.
		 *
		 * @example
		 * ```typescript
		 * type PostRow = typeof tables.get('posts').inferRow;
		 * ```
		 */
		inferRow: null as unknown as TRow,
	};
}
