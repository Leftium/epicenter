/**
 * Table Helper - YKeyValueLww-based Implementation
 *
 * Provides type-safe CRUD operations for tables stored in Y.Doc using YKeyValueLww.
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
 * @packageDocumentation
 */

import { Compile } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import type * as Y from 'yjs';
import type {
	Field,
	PartialRow,
	Row,
	TableDefinition,
} from '../../core/schema';
import { fieldsToTypebox } from '../../core/schema';
import type { TableById } from '../../core/schema/fields/types';
import {
	YKeyValueLww,
	type YKeyValueLwwChange,
	type YKeyValueLwwEntry,
} from '../../core/utils/y-keyvalue-lww';
import {
	CellKey,
	FieldId,
	hasPrefix,
	parseCellKey,
	RowId,
	RowPrefix,
	validateId,
} from './keys';

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
	id: string;
	errors: ValidationError[];
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

// Legacy type aliases for backwards compatibility with code expecting Y.Map types
// These are no longer used internally but kept for API compatibility
/** @deprecated Storage is now YKeyValueLww-based, not nested Y.Map */
export type RowMap = Y.Map<unknown>;
/** @deprecated Storage is now YKeyValueLww-based, not nested Y.Map */
export type TableMap = Y.Map<RowMap>;
/** @deprecated Storage is now YKeyValueLww-based, not nested Y.Map */
export type TablesMap = Y.Map<TableMap>;

/**
 * Creates a type-safe collection of table helpers for all tables in an array.
 *
 * Each table's `.id` is used as the key in the returned helper map.
 *
 * @param ydoc - The Y.Doc to store table data in
 * @param tableDefinitions - Array of TableDefinition objects
 *
 * @example
 * ```typescript
 * const helpers = createTableHelpers({
 *   ydoc,
 *   tableDefinitions: [
 *     table({ id: 'posts', name: 'Posts', fields: [id(), text({ id: 'title' })] }),
 *     table({ id: 'users', name: 'Users', fields: [id(), text({ id: 'name' })] }),
 *   ],
 * });
 *
 * helpers.posts.upsert({ id: '1', title: 'Hello' });
 * helpers.users.getAll();
 * ```
 */
export function createTableHelpers<
	TTableDefinitions extends readonly TableDefinition[],
>({
	ydoc,
	tableDefinitions,
}: {
	ydoc: Y.Doc;
	tableDefinitions: TTableDefinitions;
}): {
	[K in TTableDefinitions[number]['id']]: TableHelper<
		K,
		TableById<TTableDefinitions, K>['fields']
	>;
} {
	return Object.fromEntries(
		tableDefinitions.map((tableDefinition) => [
			tableDefinition.id,
			createTableHelper({
				ydoc,
				tableDefinition,
			}),
		]),
	) as {
		[K in TTableDefinitions[number]['id']]: TableHelper<
			K,
			TableById<TTableDefinitions, K>['fields']
		>;
	};
}

/**
 * Creates a single table helper with type-safe CRUD operations.
 *
 * ## Storage Architecture (YKeyValueLww Cell-Level Storage)
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
 * This keeps offline-first semantics without row-wide overwrites.
 */
export function createTableHelper<TTableDef extends TableDefinition>({
	ydoc,
	tableDefinition: { id: tableId, fields },
}: {
	ydoc: Y.Doc;
	tableDefinition: TTableDef;
}) {
	type TRow = Row<TTableDef['fields']> & { id: string };

	// Get or create the Y.Array for this table using the table: prefix convention
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(
		`table:${tableId}`,
	);
	const ykv = new YKeyValueLww<unknown>(yarray);

	const typeboxSchema = fieldsToTypebox(fields);
	const rowValidator = Compile(typeboxSchema);

	/**
	 * Validate a row against the table schema.
	 */
	const validateRow = (id: string, row: unknown): RowResult<TRow> => {
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

	function reconstructRow(rowId: string): Record<string, unknown> | undefined {
		const prefix = RowPrefix(RowId(rowId));
		const cells: Record<string, unknown> = {};
		let found = false;
		for (const [key, entry] of ykv.map) {
			if (hasPrefix(key, prefix)) {
				const { fieldId } = parseCellKey(key);
				cells[fieldId] = entry.val;
				found = true;
			}
		}
		return found ? cells : undefined;
	}

	function collectRows(): Map<string, Record<string, unknown>> {
		const rows = new Map<string, Record<string, unknown>>();
		for (const [key, entry] of ykv.map) {
			const { rowId, fieldId } = parseCellKey(key);
			const existing = rows.get(rowId) ?? {};
			existing[fieldId] = entry.val;
			rows.set(rowId, existing);
		}
		return rows;
	}

	function setRowCells(
		rowData: { id: string } & Record<string, unknown>,
	): void {
		validateId(rowData.id, 'RowId');
		const rowId = RowId(rowData.id);
		for (const [fieldId, value] of Object.entries(rowData)) {
			const cellKey = CellKey(rowId, FieldId(fieldId));
			ykv.set(cellKey, value);
		}
	}

	function hasRow(rowId: string): boolean {
		const prefix = RowPrefix(RowId(rowId));
		for (const key of ykv.map.keys()) {
			if (hasPrefix(key, prefix)) return true;
		}
		return false;
	}

	function deleteRowCells(rowId: string): boolean {
		const prefix = RowPrefix(RowId(rowId));
		const keys = Array.from(ykv.map.keys());
		const keysToDelete = keys.filter((key) => hasPrefix(key, prefix));
		for (const key of keysToDelete) {
			ykv.delete(key);
		}
		return keysToDelete.length > 0;
	}

	return {
		/** The table's unique identifier */
		id: tableId,

		update(partialRow: PartialRow<TTableDef['fields']>): UpdateResult {
			if (reconstructRow(partialRow.id) === undefined) {
				return { status: 'not_found_locally' };
			}

			ydoc.transact(() => {
				setRowCells(partialRow);
			});
			return { status: 'applied' };
		},

		upsert(rowData: TRow): void {
			ydoc.transact(() => {
				setRowCells(rowData);
			});
		},

		upsertMany(rows: TRow[]): void {
			ydoc.transact(() => {
				for (const rowData of rows) {
					setRowCells(rowData);
				}
			});
		},

		updateMany(rows: PartialRow<TTableDef['fields']>[]): UpdateManyResult {
			const applied: string[] = [];
			const notFoundLocally: string[] = [];

			ydoc.transact(() => {
				for (const partialRow of rows) {
					if (reconstructRow(partialRow.id) === undefined) {
						notFoundLocally.push(partialRow.id);
						continue;
					}
					setRowCells(partialRow);
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
			const row = reconstructRow(id);
			if (row === undefined) return { status: 'not_found', id, row: undefined };
			return validateRow(id, row);
		},

		getAll(): RowResult<TRow>[] {
			const results: RowResult<TRow>[] = [];
			for (const [rowId, row] of collectRows()) {
				results.push(validateRow(rowId, row));
			}
			return results;
		},

		getAllValid(): TRow[] {
			const result: TRow[] = [];
			for (const [_rowId, row] of collectRows()) {
				if (rowValidator.Check(row)) {
					result.push(row as TRow);
				}
			}
			return result;
		},

		getAllInvalid(): InvalidRowResult[] {
			const result: InvalidRowResult[] = [];
			for (const [rowId, row] of collectRows()) {
				const validated = validateRow(rowId, row);
				if (validated.status === 'invalid') {
					result.push(validated);
				}
			}
			return result;
		},

		has(id: string): boolean {
			return hasRow(id);
		},

		delete(id: string): DeleteResult {
			if (!deleteRowCells(id)) return { status: 'not_found_locally' };
			return { status: 'deleted' };
		},

		deleteMany(ids: string[]): DeleteManyResult {
			const deleted: string[] = [];
			const notFoundLocally: string[] = [];

			ydoc.transact(() => {
				for (const id of ids) {
					if (deleteRowCells(id)) {
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
			ydoc.transact(() => {
				const keys = Array.from(ykv.map.keys());
				for (const key of keys) {
					ykv.delete(key);
				}
			});
		},

		count(): number {
			return collectRows().size;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const result: TRow[] = [];
			for (const [_rowId, row] of collectRows()) {
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
			for (const [_rowId, row] of collectRows()) {
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
			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				transaction: Y.Transaction,
			) => {
				const changedIds = new Set<string>();
				for (const key of changes.keys()) {
					const { rowId } = parseCellKey(key);
					changedIds.add(rowId);
				}
				if (changedIds.size > 0) {
					callback(changedIds, transaction);
				}
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
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

export type TableHelper<
	TId extends string = string,
	TFields extends readonly Field[] = readonly Field[],
> = ReturnType<typeof createTableHelper<TableDefinition<TId, TFields>>>;

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
}: {
	ydoc: Y.Doc;
	tableName: string;
}): UntypedTableHelper {
	type TRow = { id: string } & Record<string, unknown>;

	// Get or create the Y.Array for this table using the table: prefix convention
	const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(
		`table:${tableName}`,
	);
	const ykv = new YKeyValueLww<unknown>(yarray);

	function reconstructRow(rowId: string): Record<string, unknown> | undefined {
		const prefix = RowPrefix(RowId(rowId));
		const cells: Record<string, unknown> = {};
		let found = false;
		for (const [key, entry] of ykv.map) {
			if (hasPrefix(key, prefix)) {
				const { fieldId } = parseCellKey(key);
				cells[fieldId] = entry.val;
				found = true;
			}
		}
		return found ? cells : undefined;
	}

	function collectRows(): Map<string, Record<string, unknown>> {
		const rows = new Map<string, Record<string, unknown>>();
		for (const [key, entry] of ykv.map) {
			const { rowId, fieldId } = parseCellKey(key);
			const existing = rows.get(rowId) ?? {};
			existing[fieldId] = entry.val;
			rows.set(rowId, existing);
		}
		return rows;
	}

	function setRowCells(rowData: TRow): void {
		validateId(rowData.id, 'RowId');
		const rowId = RowId(rowData.id);
		for (const [fieldId, value] of Object.entries(rowData)) {
			const cellKey = CellKey(rowId, FieldId(fieldId));
			ykv.set(cellKey, value);
		}
	}

	function hasRow(rowId: string): boolean {
		const prefix = RowPrefix(RowId(rowId));
		for (const key of ykv.map.keys()) {
			if (hasPrefix(key, prefix)) return true;
		}
		return false;
	}

	function deleteRowCells(rowId: string): boolean {
		const prefix = RowPrefix(RowId(rowId));
		const keys = Array.from(ykv.map.keys());
		const keysToDelete = keys.filter((key) => hasPrefix(key, prefix));
		for (const key of keysToDelete) {
			ykv.delete(key);
		}
		return keysToDelete.length > 0;
	}

	return {
		update(partialRow: TRow): UpdateResult {
			if (reconstructRow(partialRow.id) === undefined)
				return { status: 'not_found_locally' };

			setRowCells(partialRow);
			return { status: 'applied' };
		},

		upsert(rowData: TRow): void {
			setRowCells(rowData);
		},

		upsertMany(rows: TRow[]): void {
			ydoc.transact(() => {
				for (const rowData of rows) {
					setRowCells(rowData);
				}
			});
		},

		updateMany(rows: TRow[]): UpdateManyResult {
			const applied: string[] = [];
			const notFoundLocally: string[] = [];

			ydoc.transact(() => {
				for (const partialRow of rows) {
					if (reconstructRow(partialRow.id) === undefined) {
						notFoundLocally.push(partialRow.id);
						continue;
					}
					setRowCells(partialRow);
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
			const row = reconstructRow(id);
			if (row === undefined) return { status: 'not_found', id, row: undefined };
			// No validation for untyped tables - always valid
			return { status: 'valid', row: row as TRow };
		},

		getAll(): RowResult<TRow>[] {
			const results: RowResult<TRow>[] = [];
			for (const [_rowId, row] of collectRows()) {
				results.push({ status: 'valid', row: row as TRow });
			}
			return results;
		},

		getAllValid(): TRow[] {
			const result: TRow[] = [];
			for (const [_rowId, row] of collectRows()) {
				result.push(row as TRow);
			}
			return result;
		},

		getAllInvalid(): InvalidRowResult[] {
			// No validation for untyped tables - nothing is ever invalid
			return [];
		},

		has(id: string): boolean {
			return hasRow(id);
		},

		delete(id: string): DeleteResult {
			if (!deleteRowCells(id)) return { status: 'not_found_locally' };
			return { status: 'deleted' };
		},

		deleteMany(ids: string[]): DeleteManyResult {
			const deleted: string[] = [];
			const notFoundLocally: string[] = [];

			ydoc.transact(() => {
				for (const id of ids) {
					if (deleteRowCells(id)) {
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

		clear(): void {
			ydoc.transact(() => {
				const keys = Array.from(ykv.map.keys());
				for (const key of keys) {
					ykv.delete(key);
				}
			});
		},

		count(): number {
			return collectRows().size;
		},

		filter(predicate: (row: TRow) => boolean): TRow[] {
			const result: TRow[] = [];
			for (const [_rowId, row] of collectRows()) {
				const typedRow = row as TRow;
				if (predicate(typedRow)) {
					result.push(typedRow);
				}
			}
			return result;
		},

		find(predicate: (row: TRow) => boolean): TRow | null {
			for (const [_rowId, row] of collectRows()) {
				const typedRow = row as TRow;
				if (predicate(typedRow)) {
					return typedRow;
				}
			}
			return null;
		},

		observe(
			callback: (changedIds: ChangedRowIds, transaction: Y.Transaction) => void,
		): () => void {
			const handler = (
				changes: Map<string, YKeyValueLwwChange<unknown>>,
				transaction: Y.Transaction,
			) => {
				const changedIds = new Set<string>();
				for (const key of changes.keys()) {
					const { rowId } = parseCellKey(key);
					changedIds.add(rowId);
				}
				if (changedIds.size > 0) {
					callback(changedIds, transaction);
				}
			};

			ykv.observe(handler);
			return () => ykv.unobserve(handler);
		},

		inferRow: null as unknown as TRow,
	};
}
