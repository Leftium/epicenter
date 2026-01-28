/**
 * Table Store for Cell Workspace
 *
 * A unified store for a single table. Every entry is a cell value,
 * including row metadata (stored as reserved fields `_order`, `_deletedAt`).
 *
 * Y.Doc structure:
 * ```
 * Y.Array(tableId)              ← One array per table
 * ├── { key: 'row1:title',      val: 'Hello',  ts: ... }
 * ├── { key: 'row1:views',      val: 100,      ts: ... }
 * ├── { key: 'row1:_order',     val: 1,        ts: ... }
 * ├── { key: 'row1:_deletedAt', val: null,     ts: ... }
 * └── ...
 * ```
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../core/utils/y-keyvalue-lww';
import type { CellValue, TableStore, ChangeHandler, RowData } from './types';
import {
	cellKey,
	parseCellKey,
	rowPrefix,
	hasPrefix,
	validateId,
	validateFieldId,
	generateRowId,
	ROW_ORDER_FIELD,
	ROW_DELETED_AT_FIELD,
} from './keys';

/**
 * Create a table store backed by a Y.Array.
 *
 * @param tableId - The table identifier (used for error messages)
 * @param yarray - The Y.Array for this table's data
 */
export function createTableStore(
	tableId: string,
	yarray: Y.Array<YKeyValueLwwEntry<CellValue>>,
): TableStore {
	const ykv = new YKeyValueLww<CellValue>(yarray);

	// ══════════════════════════════════════════════════════════════════════
	// Cell Operations
	// ══════════════════════════════════════════════════════════════════════

	function get(rowId: string, fieldId: string): CellValue | undefined {
		return ykv.get(cellKey(rowId, fieldId));
	}

	function set(rowId: string, fieldId: string, value: CellValue): void {
		validateId(rowId, 'rowId');
		validateFieldId(fieldId);
		ykv.set(cellKey(rowId, fieldId), value);
	}

	function del(rowId: string, fieldId: string): void {
		validateFieldId(fieldId);
		ykv.delete(cellKey(rowId, fieldId));
	}

	function has(rowId: string, fieldId: string): boolean {
		return ykv.has(cellKey(rowId, fieldId));
	}

	// ══════════════════════════════════════════════════════════════════════
	// Row Operations
	// ══════════════════════════════════════════════════════════════════════

	function getRow(rowId: string): Record<string, CellValue> | undefined {
		const prefix = rowPrefix(rowId);
		const cells: Record<string, CellValue> = {};
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

	function getRowOrder(rowId: string): number | undefined {
		const order = get(rowId, ROW_ORDER_FIELD);
		return typeof order === 'number' ? order : undefined;
	}

	function getRowDeletedAt(rowId: string): number | null | undefined {
		const deletedAt = get(rowId, ROW_DELETED_AT_FIELD);
		if (deletedAt === undefined) return undefined;
		return deletedAt === null ? null : (deletedAt as number);
	}

	function isRowDeleted(rowId: string): boolean {
		const deletedAt = getRowDeletedAt(rowId);
		return deletedAt !== undefined && deletedAt !== null;
	}

	function createRow(rowId?: string, order?: number): string {
		const id = rowId ?? generateRowId();
		if (rowId) validateId(rowId, 'rowId');

		// Calculate order if not provided
		let finalOrder = order;
		if (finalOrder === undefined) {
			const rows = getAllRows();
			const activeRows = rows.filter((r) => !isRowDeleted(r.id));
			if (activeRows.length > 0) {
				const maxOrder = Math.max(
					...activeRows.map((r) => r.cells[ROW_ORDER_FIELD] as number),
				);
				finalOrder = maxOrder + 1;
			} else {
				finalOrder = 1;
			}
		}

		// Set row metadata
		ykv.set(cellKey(id, ROW_ORDER_FIELD), finalOrder);
		ykv.set(cellKey(id, ROW_DELETED_AT_FIELD), null);

		return id;
	}

	function deleteRow(rowId: string): void {
		const deletedAt = getRowDeletedAt(rowId);
		if (deletedAt === null) {
			// Row exists and is not deleted - soft delete it
			ykv.set(cellKey(rowId, ROW_DELETED_AT_FIELD), Date.now());
		}
	}

	function restoreRow(rowId: string): void {
		const deletedAt = getRowDeletedAt(rowId);
		if (deletedAt !== null && deletedAt !== undefined) {
			// Row exists and is deleted - restore it
			ykv.set(cellKey(rowId, ROW_DELETED_AT_FIELD), null);
		}
	}

	function reorderRow(rowId: string, newOrder: number): void {
		if (getRowOrder(rowId) !== undefined) {
			ykv.set(cellKey(rowId, ROW_ORDER_FIELD), newOrder);
		}
	}

	// ══════════════════════════════════════════════════════════════════════
	// Bulk Operations
	// ══════════════════════════════════════════════════════════════════════

	function getAllRows(): RowData[] {
		// Group cells by rowId
		const rowsMap = new Map<string, Record<string, CellValue>>();

		for (const [key, entry] of ykv.map) {
			const { rowId, fieldId } = parseCellKey(key);
			let row = rowsMap.get(rowId);
			if (!row) {
				row = {};
				rowsMap.set(rowId, row);
			}
			row[fieldId] = entry.val;
		}

		// Convert to array and sort by order
		const rows: RowData[] = [];
		for (const [id, cells] of rowsMap) {
			// Only include rows that have metadata (were properly created)
			if (ROW_ORDER_FIELD in cells) {
				rows.push({ id, cells });
			}
		}

		// Sort by order, then by id for deterministic ordering
		return rows.sort((a, b) => {
			const orderA = a.cells[ROW_ORDER_FIELD] as number;
			const orderB = b.cells[ROW_ORDER_FIELD] as number;
			if (orderA !== orderB) return orderA - orderB;
			return a.id.localeCompare(b.id);
		});
	}

	function getRows(): RowData[] {
		return getAllRows().filter((r) => r.cells[ROW_DELETED_AT_FIELD] === null);
	}

	function getRowsWithoutMeta(): Array<{
		id: string;
		order: number;
		deletedAt: number | null;
		cells: Record<string, CellValue>;
	}> {
		return getRows().map((r) => {
			const { [ROW_ORDER_FIELD]: order, [ROW_DELETED_AT_FIELD]: deletedAt, ...cells } =
				r.cells;
			return {
				id: r.id,
				order: order as number,
				deletedAt: deletedAt as number | null,
				cells,
			};
		});
	}

	// ══════════════════════════════════════════════════════════════════════
	// Observation
	// ══════════════════════════════════════════════════════════════════════

	function observe(handler: ChangeHandler<CellValue>): () => void {
		const ykvHandler = (
			changes: Map<
				string,
				import('../core/utils/y-keyvalue-lww').YKeyValueLwwChange<CellValue>
			>,
			transaction: Y.Transaction,
		) => {
			const events: import('./types').ChangeEvent<CellValue>[] = [];

			for (const [key, change] of changes) {
				if (change.action === 'add') {
					events.push({ type: 'add', key, value: change.newValue });
				} else if (change.action === 'update') {
					events.push({
						type: 'update',
						key,
						value: change.newValue,
						previousValue: change.oldValue,
					});
				} else if (change.action === 'delete') {
					events.push({ type: 'delete', key, previousValue: change.oldValue });
				}
			}

			if (events.length > 0) {
				handler(events, transaction);
			}
		};

		ykv.observe(ykvHandler);
		return () => ykv.unobserve(ykvHandler);
	}

	return {
		tableId,

		// Cell operations
		get,
		set,
		delete: del,
		has,

		// Row operations
		getRow,
		createRow,
		deleteRow,
		restoreRow,
		reorderRow,

		// Bulk operations
		getAllRows,
		getRows,
		getRowsWithoutMeta,

		// Observation
		observe,
	};
}
