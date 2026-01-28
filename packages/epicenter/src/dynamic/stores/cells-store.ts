/**
 * CellsStore - Store for dynamic cell values
 *
 * Wraps YKeyValueLww to provide cell-specific operations with
 * composite keys (tableId:rowId:fieldId). Cells do NOT have tombstones -
 * they are filtered based on their row/field's deletedAt status.
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import { YKeyValueLww } from '../../core/utils/y-keyvalue-lww.js';
import { cellKey, validateId } from '../keys.js';
import type {
	CellsStore,
	CellValue,
	ChangeEvent,
	ChangeHandler,
} from '../types.js';

/**
 * Create a CellsStore wrapping a YKeyValueLww instance.
 *
 * @param ykv - The YKeyValueLww instance to wrap
 * @returns A CellsStore implementation
 */
export function createCellsStore(ykv: YKeyValueLww<CellValue>): CellsStore {
	return {
		get(
			tableId: string,
			rowId: string,
			fieldId: string,
		): CellValue | undefined {
			return ykv.get(cellKey(tableId, rowId, fieldId));
		},

		set(
			tableId: string,
			rowId: string,
			fieldId: string,
			value: CellValue,
		): void {
			validateId(tableId, 'tableId');
			validateId(rowId, 'rowId');
			validateId(fieldId, 'fieldId');
			ykv.set(cellKey(tableId, rowId, fieldId), value);
		},

		delete(tableId: string, rowId: string, fieldId: string): void {
			ykv.delete(cellKey(tableId, rowId, fieldId));
		},

		has(tableId: string, rowId: string, fieldId: string): boolean {
			return ykv.has(cellKey(tableId, rowId, fieldId));
		},

		getByRow(
			tableId: string,
			rowId: string,
			fieldIds: string[],
		): Map<string, CellValue> {
			const result = new Map<string, CellValue>();
			for (const fieldId of fieldIds) {
				const key = cellKey(tableId, rowId, fieldId);
				const value = ykv.get(key);
				if (value !== undefined) {
					result.set(fieldId, value);
				}
			}
			return result;
		},

		observe(handler: ChangeHandler<CellValue>): () => void {
			const wrappedHandler = (
				changes: Map<
					string,
					{ action: string; oldValue?: CellValue; newValue?: CellValue }
				>,
				transaction: Y.Transaction,
			) => {
				const events: ChangeEvent<CellValue>[] = [];
				for (const [key, change] of changes) {
					if (change.action === 'add' && change.newValue !== undefined) {
						events.push({ type: 'add', key, value: change.newValue });
					} else if (
						change.action === 'update' &&
						change.oldValue !== undefined &&
						change.newValue !== undefined
					) {
						events.push({
							type: 'update',
							key,
							value: change.newValue,
							previousValue: change.oldValue,
						});
					} else if (
						change.action === 'delete' &&
						change.oldValue !== undefined
					) {
						events.push({
							type: 'delete',
							key,
							previousValue: change.oldValue,
						});
					}
				}
				if (events.length > 0) {
					handler(events, transaction);
				}
			};

			ykv.observe(wrappedHandler);
			return () => ykv.unobserve(wrappedHandler);
		},
	};
}
