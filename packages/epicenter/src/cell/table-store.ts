/**
 * Table Store for Cell Workspace
 *
 * A unified store for a single table. Every entry is a cell value.
 * No built-in ordering or soft-delete - implement these as regular fields if needed.
 *
 * Y.Doc structure:
 * ```
 * Y.Array(tableId)              ← One array per table
 * ├── { key: 'row1:title',      val: 'Hello',  ts: ... }
 * ├── { key: 'row1:views',      val: 100,      ts: ... }
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
	generateRowId,
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
		validateId(fieldId, 'fieldId');
		ykv.set(cellKey(rowId, fieldId), value);
	}

	function del(rowId: string, fieldId: string): void {
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

	function createRow(rowId?: string): string {
		const id = rowId ?? generateRowId();
		if (rowId) validateId(rowId, 'rowId');
		// Row is "created" implicitly when you set cells on it
		// This just generates/validates the ID
		return id;
	}

	function deleteRow(rowId: string): void {
		// Hard delete - remove all cells for this row
		const prefix = rowPrefix(rowId);
		const keysToDelete: string[] = [];

		for (const [key] of ykv.map) {
			if (hasPrefix(key, prefix)) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			ykv.delete(key);
		}
	}

	// ══════════════════════════════════════════════════════════════════════
	// Bulk Operations
	// ══════════════════════════════════════════════════════════════════════

	function getRows(): RowData[] {
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

		// Convert to array, sorted by id for deterministic ordering
		const rows: RowData[] = [];
		for (const [id, cells] of rowsMap) {
			rows.push({ id, cells });
		}

		return rows.sort((a, b) => a.id.localeCompare(b.id));
	}

	function getRowIds(): string[] {
		const ids = new Set<string>();
		for (const [key] of ykv.map) {
			const { rowId } = parseCellKey(key);
			ids.add(rowId);
		}
		return Array.from(ids).sort();
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

		// Bulk operations
		getRows,
		getRowIds,

		// Observation
		observe,
	};
}
