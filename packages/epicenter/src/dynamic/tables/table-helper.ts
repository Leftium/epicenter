/**
 * Table Helper - CellStore + RowStore Composition
 *
 * Provides type-safe CRUD operations for tables stored in Y.Doc using CellStore + RowStore.
 * Each table is stored as a Y.Array with LWW (Last-Write-Wins) conflict resolution per cell.
 *
 * Storage format:
 * ```
 * Y.Doc
 * └── Y.Array('table:posts')       ← Table
 *     └── { key: 'row-123:title', val: 'Hello', ts: 1706200000 }
 *     └── { key: 'row-123:views', val: 100, ts: 1706200001 }
 * ```
 *
 * ## Architecture
 *
 * Composes three layers:
 * - **YKeyValueLww**: Generic key-value with LWW conflict resolution (CRDT primitive)
 * - **CellStore**: Cell semantics (rowId:columnId key parsing, typed change events)
 * - **RowStore**: In-memory row index (O(1) has/count, O(m) get/delete)
 * - **TableHelper** (this): Schema validation, typed CRUD, branded Id types
 *
 * The RowStore maintains a `Map<rowId, Map<columnId, value>>` index that is
 * updated reactively via CellStore observers. This gives O(1) row existence
 * checks and O(m) row reconstruction (where m = fields per row), eliminating
 * the O(n) full-table scans that were previously required.
 *
 * @packageDocumentation
 */

import { Compile } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import type * as Y from 'yjs';
import { type BaseRow, Id } from '../../shared/id.js';
import { TableKey } from '../../shared/ydoc-keys';
import type { PartialRow, Row, TableDefinition } from '../schema';
import { fieldsToTypebox } from '../schema';
import { createCellStore } from './y-cell-store.js';
import { createRowStore } from './y-row-store.js';

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

/** A row that passed validation. */
export type ValidRowResult<TRow> = { status: 'valid'; row: TRow };

/** A row that exists but failed validation. */
export type InvalidRowResult = {
	status: 'invalid';
	id: Id;
	errors: ValidationError[];
	row: unknown;
};

/**
 * A row that was not found.
 * Includes `row: undefined` so row can always be destructured regardless of status.
 */
export type NotFoundResult = {
	status: 'not_found';
	id: Id;
	row: undefined;
};

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
 * This avoids creating partially-defined rows that may fail validation until a
 * full upsert arrives, while still letting cell-level LWW merge safely.
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
	| { status: 'all_applied'; applied: Id[] }
	| {
			status: 'partially_applied';
			applied: Id[];
			notFoundLocally: Id[];
	  }
	| { status: 'none_applied'; notFoundLocally: Id[] };

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
	| { status: 'all_deleted'; deleted: Id[] }
	| {
			status: 'partially_deleted';
			deleted: Id[];
			notFoundLocally: Id[];
	  }
	| { status: 'none_deleted'; notFoundLocally: Id[] };

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
export type ChangedRowIds = Set<Id>;

/**
 * Creates a single table helper with type-safe CRUD operations.
 *
 * ## Storage Architecture (CellStore + RowStore Composition)
 *
 * Each table is a Y.Array storing individual cells as
 * `{ key: 'rowId:fieldId', val: value, ts: timestamp }`.
 * The LWW (Last-Write-Wins) timestamp applies per cell, so concurrent edits
 * to different fields merge cleanly:
 *
 * ```
 * User A edits title at t=100, User B edits views at t=200 → After sync: both fields are present
 * ```
 *
 * RowStore maintains an in-memory index for O(1) row existence checks and
 * O(m) row reconstruction. This keeps offline-first semantics without
 * row-wide overwrites while avoiding O(n) full-table scans.
 */
export function createTableHelper<TTableDef extends TableDefinition>({
	ydoc,
	tableDefinition: { id: tableId, fields },
}: {
	ydoc: Y.Doc;
	tableDefinition: TTableDef;
}): TableHelper<Row<TTableDef['fields']> & BaseRow> {
	type TRow = Row<TTableDef['fields']> & BaseRow;

	// Compose storage layers: YKeyValueLww → CellStore → RowStore
	const cellStore = createCellStore<unknown>(ydoc, TableKey(tableId));
	const rowStore = createRowStore(cellStore);

	const typeboxSchema = fieldsToTypebox(fields);
	const rowValidator = Compile(typeboxSchema);

	/**
	 * Validate a row against the table schema.
	 */
	const validateRow = (id: Id, row: unknown): RowResult<TRow> => {
		if (rowValidator.Check(row)) {
			return { status: 'valid', row: row as TRow };
		}
		return {
			status: 'invalid',
			id,
			errors: rowValidator.Errors(row),
			row,
		};
	};

	return {
		/** The table's unique identifier */
		id: tableId,

		update(partialRow: PartialRow<TTableDef['fields']>): UpdateResult {
			if (!rowStore.has(partialRow.id)) {
				return { status: 'not_found_locally' };
			}

			ydoc.transact(() => {
				rowStore.merge(partialRow.id, partialRow);
			});
			return { status: 'applied' };
		},

		upsert(rowData: TRow): void {
			rowStore.merge(rowData.id, rowData);
		},

		upsertMany(rows: TRow[]): void {
			ydoc.transact(() => {
				for (const rowData of rows) {
					rowStore.merge(rowData.id, rowData);
				}
			});
		},

		updateMany(rows: PartialRow<TTableDef['fields']>[]): UpdateManyResult {
			const applied: Id[] = [];
			const notFoundLocally: Id[] = [];

			ydoc.transact(() => {
				for (const partialRow of rows) {
					if (!rowStore.has(partialRow.id)) {
						notFoundLocally.push(partialRow.id);
						continue;
					}
					rowStore.merge(partialRow.id, partialRow);
					applied.push(partialRow.id);
				}
			});

			if (notFoundLocally.length === 0)
				return { status: 'all_applied', applied };
			if (applied.length === 0)
				return { status: 'none_applied', notFoundLocally };
			return { status: 'partially_applied', applied, notFoundLocally };
		},

		get(id: Id): GetResult<TRow> {
			const row = rowStore.get(id);
			if (row === undefined) return { status: 'not_found', id, row: undefined };
			return validateRow(id, row);
		},

		getAll(): RowResult<TRow>[] {
			const results: RowResult<TRow>[] = [];
			for (const [rowId, row] of rowStore.getAll()) {
				results.push(validateRow(Id(rowId), row));
			}
			return results;
		},

		getAllValid(): TRow[] {
			const result: TRow[] = [];
			for (const [_rowId, row] of rowStore.getAll()) {
				if (rowValidator.Check(row)) {
					result.push(row as TRow);
				}
			}
			return result;
		},

		getAllInvalid(): InvalidRowResult[] {
			const result: InvalidRowResult[] = [];
			for (const [rowId, row] of rowStore.getAll()) {
				const validated = validateRow(Id(rowId), row);
				if (validated.status === 'invalid') {
					result.push(validated);
				}
			}
			return result;
		},

		has(id: Id): boolean {
			return rowStore.has(id);
		},

		delete(id: Id): DeleteResult {
			if (!rowStore.delete(id)) return { status: 'not_found_locally' };
			return { status: 'deleted' };
		},

		deleteMany(ids: Id[]): DeleteManyResult {
			const deleted: Id[] = [];
			const notFoundLocally: Id[] = [];

			ydoc.transact(() => {
				for (const id of ids) {
					if (rowStore.delete(id)) {
						deleted.push(id);
						continue;
					}
					notFoundLocally.push(id);
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
		 * This method deletes all rows within the table, but the table's Y.Array
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
			cellStore.clear();
		},

		count(): number {
			return rowStore.count();
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const result: TRow[] = [];
			for (const [_rowId, row] of rowStore.getAll()) {
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
			for (const [_rowId, row] of rowStore.getAll()) {
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
			return rowStore.observe((changedRowIds, transaction) => {
				const changedIds = new Set<Id>();
				for (const rowId of changedRowIds) {
					changedIds.add(Id(rowId));
				}
				if (changedIds.size > 0) {
					callback(changedIds, transaction);
				}
			});
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

/**
 * Type-safe table helper for a single dynamic workspace table.
 *
 * Provides CRUD operations, reactive observation, and schema validation
 * over a Y.Doc-backed CellStore + RowStore. Each method is typed against
 * the table's row type (`TRow`), which is computed from the table's field
 * definitions at the `createTables` / `createTableHelper` level.
 *
 * ## Row Type
 *
 * `TRow` always includes `{ id: Id }` plus the fields defined in the table
 * schema. For example, a table with `text('title')` and `boolean('published')`
 * produces `TRow = { id: Id; title: string; published: boolean }`.
 *
 * ## Difference from Static API's TableHelper
 *
 * The dynamic API's `TableHelper` has richer batch operations (`upsertMany`,
 * `updateMany`, `deleteMany`) and uses branded `Id` types, while the static
 * API has a general `batch()` transaction and `parse()`. They share a common
 * core but diverge intentionally based on their domains.
 *
 * @typeParam TRow - The fully-typed row shape for this table (includes `{ id: Id }`)
 */
export type TableHelper<TRow extends BaseRow = BaseRow> = {
	// ═══════════════════════════════════════════════════════════════════════
	// IDENTITY
	// ═══════════════════════════════════════════════════════════════════════

	/** The table's unique identifier (e.g. `'posts'`). */
	id: string;

	// ═══════════════════════════════════════════════════════════════════════
	// WRITE — Upsert (insert or replace)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Insert or replace a single row. Never fails.
	 *
	 * Uses cell-level LWW merge under the hood, so concurrent edits to
	 * different fields merge cleanly across peers.
	 *
	 * @param row - The full row to upsert (must include `id`)
	 */
	upsert(row: TRow): void;

	/**
	 * Insert or replace multiple rows in a single Y.js transaction.
	 *
	 * All rows are merged atomically — observers fire once, not per-row.
	 *
	 * @param rows - Array of full rows to upsert
	 */
	upsertMany(rows: TRow[]): void;

	// ═══════════════════════════════════════════════════════════════════════
	// WRITE — Update (partial merge into existing)
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Partially update an existing row by merging fields.
	 *
	 * If the row doesn't exist locally, returns `{ status: 'not_found_locally' }`.
	 * This is intentional: creating a new row from a partial update could
	 * overwrite a row arriving from another peer.
	 *
	 * @param partialRow - Object with `id` plus any fields to update
	 * @returns Whether the update was applied or the row wasn't found
	 */
	update(partialRow: Partial<Omit<TRow, 'id'>> & { id: Id }): UpdateResult;

	/**
	 * Partially update multiple existing rows in a single Y.js transaction.
	 *
	 * Rows that don't exist locally are skipped (see `update` for rationale).
	 *
	 * @param rows - Array of partial row objects (each must include `id`)
	 * @returns Aggregated result: all_applied, partially_applied, or none_applied
	 */
	updateMany(
		rows: (Partial<Omit<TRow, 'id'>> & { id: Id })[],
	): UpdateManyResult;

	// ═══════════════════════════════════════════════════════════════════════
	// READ — Single row
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Get a single row by ID.
	 *
	 * Returns a discriminated union:
	 * - `{ status: 'valid', row }` — Row exists and passes schema validation
	 * - `{ status: 'invalid', id, errors, row }` — Row exists but fails validation
	 * - `{ status: 'not_found', id, row: undefined }` — Row doesn't exist
	 *
	 * @param id - The row's branded Id
	 */
	get(id: Id): GetResult<TRow>;

	// ═══════════════════════════════════════════════════════════════════════
	// READ — All rows
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Get all rows with their validation status.
	 *
	 * Each result is either `{ status: 'valid', row }` or
	 * `{ status: 'invalid', id, errors, row }`.
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
	 * Useful for debugging data corruption or schema drift after migrations.
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
	 * Invalid rows are silently skipped. Returns `null` if no match found.
	 *
	 * @param predicate - Function that returns `true` for the desired row
	 * @returns The first matching valid row, or `null`
	 */
	find(predicate: (row: TRow) => boolean): TRow | null;

	// ═══════════════════════════════════════════════════════════════════════
	// EXISTENCE & COUNT
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Check if a row exists by ID.
	 *
	 * Uses the in-memory RowStore index for O(1) lookup.
	 *
	 * @param id - The row's branded Id
	 */
	has(id: Id): boolean;

	/**
	 * Get the total number of rows in the table.
	 *
	 * Includes both valid and invalid rows (any row that has cells in storage).
	 */
	count(): number;

	// ═══════════════════════════════════════════════════════════════════════
	// DELETE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Delete a single row by ID.
	 *
	 * If the row doesn't exist locally, returns `{ status: 'not_found_locally' }`.
	 * Deleting a non-existent key is a no-op in Yjs — no operation is recorded,
	 * so the delete won't propagate to other peers.
	 *
	 * @param id - The row's branded Id
	 */
	delete(id: Id): DeleteResult;

	/**
	 * Delete multiple rows in a single Y.js transaction.
	 *
	 * Rows that don't exist locally are tracked separately in the result.
	 *
	 * @param ids - Array of branded Ids to delete
	 * @returns Aggregated result: all_deleted, partially_deleted, or none_deleted
	 */
	deleteMany(ids: Id[]): DeleteManyResult;

	/**
	 * Delete all rows from the table.
	 *
	 * The table's Y.Array structure itself is preserved — tables are permanent.
	 * Observers remain attached, and `tables.get('posts')` continues to work.
	 * If you need to "reset" a table, call `clear()`.
	 */
	clear(): void;

	// ═══════════════════════════════════════════════════════════════════════
	// OBSERVE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Watch for row changes.
	 *
	 * The callback receives a `Set<Id>` of row IDs that changed. To determine
	 * what happened, call `table.get(id)`:
	 * - `status === 'not_found'` → the row was deleted
	 * - Otherwise → the row was added or updated
	 *
	 * Changes are batched per Y.Transaction — `upsertMany(1000)` fires ONE
	 * callback with 1000 IDs. If a row changes multiple times in one
	 * transaction, it appears once in the Set.
	 *
	 * @param callback - Receives changed IDs and the Y.Transaction
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
	): () => void;

	// ═══════════════════════════════════════════════════════════════════════
	// TYPE INFERENCE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Type inference helper for extracting the row type.
	 *
	 * This property is `null` at runtime — it exists solely for TypeScript's
	 * type system. Use `typeof table.inferRow` to extract the row type.
	 *
	 * @example
	 * ```typescript
	 * type PostRow = typeof tables.get('posts').inferRow;
	 * ```
	 */
	inferRow: TRow;
};
