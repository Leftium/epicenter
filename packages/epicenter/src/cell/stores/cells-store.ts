/**
 * Cells Store for Cell Workspace
 *
 * Stores cell values in Y.Doc using YKeyValueLww.
 * Cell keys: `{tableId}:{rowId}:{fieldId}`
 *
 * Unlike rows, cells do NOT have tombstones - they are hard deleted.
 * Cell visibility is controlled by the row's deletedAt status.
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../../core/utils/y-keyvalue-lww';
import type {
	CellValue,
	CellsStore,
	ChangeHandler,
	ChangeEvent,
} from '../types';
import {
	cellKey,
	parseCellKey,
	rowCellPrefix,
	hasPrefix,
	validateId,
} from '../keys';

/**
 * Y.Array name for cells store.
 */
export const CELLS_ARRAY_NAME = 'cell:cells';

/**
 * Create a cells store backed by YKeyValueLww.
 */
export function createCellsStore(
	yarray: Y.Array<YKeyValueLwwEntry<CellValue>>,
): CellsStore {
	const ykv = new YKeyValueLww<CellValue>(yarray);

	function get(
		tableId: string,
		rowId: string,
		fieldId: string,
	): CellValue | undefined {
		return ykv.get(cellKey(tableId, rowId, fieldId));
	}

	function set(
		tableId: string,
		rowId: string,
		fieldId: string,
		value: CellValue,
	): void {
		validateId(tableId, 'tableId');
		validateId(rowId, 'rowId');
		validateId(fieldId, 'fieldId');
		ykv.set(cellKey(tableId, rowId, fieldId), value);
	}

	function del(tableId: string, rowId: string, fieldId: string): void {
		ykv.delete(cellKey(tableId, rowId, fieldId));
	}

	function has(tableId: string, rowId: string, fieldId: string): boolean {
		return ykv.has(cellKey(tableId, rowId, fieldId));
	}

	function getByRow(tableId: string, rowId: string): Map<string, CellValue> {
		const prefix = rowCellPrefix(tableId, rowId);
		const results = new Map<string, CellValue>();

		for (const [key, entry] of ykv.map) {
			if (hasPrefix(key, prefix)) {
				const { fieldId } = parseCellKey(key);
				results.set(fieldId, entry.val);
			}
		}

		return results;
	}

	function getByRowFields(
		tableId: string,
		rowId: string,
		fieldIds: string[],
	): Map<string, CellValue> {
		const results = new Map<string, CellValue>();

		for (const fieldId of fieldIds) {
			const value = get(tableId, rowId, fieldId);
			if (value !== undefined) {
				results.set(fieldId, value);
			}
		}

		return results;
	}

	function observe(handler: ChangeHandler<CellValue>): () => void {
		const ykvHandler = (
			changes: Map<string, import('../../core/utils/y-keyvalue-lww').YKeyValueLwwChange<CellValue>>,
			transaction: Y.Transaction,
		) => {
			const events: ChangeEvent<CellValue>[] = [];

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
		get,
		set,
		delete: del,
		has,
		getByRow,
		getByRowFields,
		observe,
	};
}
