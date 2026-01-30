/**
 * RowsStore - Store for dynamic row metadata
 *
 * Wraps YKeyValueLww to provide row-specific operations with
 * composite keys (tableId:rowId) and soft delete support.
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import type { YKeyValueLww } from '../../core/utils/y-keyvalue-lww.js';
import {
	generateRowId,
	parseRowKey,
	rowKey,
	tablePrefix,
	validateId,
} from '../keys.js';
import type {
	ChangeEvent,
	ChangeHandler,
	RowMeta,
	RowsStore,
} from '../types.js';

/**
 * Create a RowsStore wrapping a YKeyValueLww instance.
 *
 * @param ykv - The YKeyValueLww instance to wrap
 * @returns A RowsStore implementation
 */
export function createRowsStore(ykv: YKeyValueLww<RowMeta>): RowsStore {
	/**
	 * Calculate the next order value for a new row in a table.
	 * Returns max(existing orders) + 1, or 1 if no rows exist.
	 *
	 * Uses `entries()` to iterate over both pending and confirmed entries,
	 * ensuring correct ordering when called inside a batch.
	 */
	function getNextOrder(tableId: string): number {
		const prefix = tablePrefix(tableId);
		let maxOrder = 0;
		for (const [key, entry] of ykv.entries()) {
			if (key.startsWith(prefix) && entry.val.deletedAt === null) {
				maxOrder = Math.max(maxOrder, entry.val.order);
			}
		}
		return maxOrder + 1;
	}

	return {
		get(tableId: string, rowId: string): RowMeta | undefined {
			return ykv.get(rowKey(tableId, rowId));
		},

		set(tableId: string, rowId: string, meta: RowMeta): void {
			validateId(tableId, 'tableId');
			validateId(rowId, 'rowId');
			ykv.set(rowKey(tableId, rowId), meta);
		},

		delete(tableId: string, rowId: string): void {
			const key = rowKey(tableId, rowId);
			const row = ykv.get(key);
			if (row && row.deletedAt === null) {
				ykv.set(key, { ...row, deletedAt: Date.now() });
			}
		},

		has(tableId: string, rowId: string): boolean {
			return ykv.has(rowKey(tableId, rowId));
		},

		getByTable(tableId: string): Array<{ id: string; meta: RowMeta }> {
			const prefix = tablePrefix(tableId);
			const result: Array<{ id: string; meta: RowMeta }> = [];

			// Use entries() to include both pending and confirmed entries
			for (const [key, entry] of ykv.entries()) {
				if (key.startsWith(prefix)) {
					const { rowId } = parseRowKey(key);
					result.push({ id: rowId, meta: entry.val });
				}
			}

			// Sort by order, then by row ID as tiebreaker
			return result.sort((a, b) => {
				if (a.meta.order !== b.meta.order) {
					return a.meta.order - b.meta.order;
				}
				return a.id.localeCompare(b.id);
			});
		},

		getActiveByTable(tableId: string): Array<{ id: string; meta: RowMeta }> {
			return this.getByTable(tableId).filter((r) => r.meta.deletedAt === null);
		},

		create(tableId: string, rowId?: string, order?: number): string {
			validateId(tableId, 'tableId');
			const id = rowId ?? generateRowId();
			if (rowId !== undefined) {
				validateId(rowId, 'rowId');
			}

			const key = rowKey(tableId, id);
			if (ykv.has(key)) {
				throw new Error(`Row "${id}" already exists in table "${tableId}"`);
			}

			const meta: RowMeta = {
				order: order ?? getNextOrder(tableId),
				deletedAt: null,
			};

			ykv.set(key, meta);
			return id;
		},

		reorder(tableId: string, rowId: string, newOrder: number): void {
			const key = rowKey(tableId, rowId);
			const row = ykv.get(key);
			if (!row) {
				throw new Error(`Row "${rowId}" not found in table "${tableId}"`);
			}
			ykv.set(key, { ...row, order: newOrder });
		},

		restore(tableId: string, rowId: string): void {
			const key = rowKey(tableId, rowId);
			const row = ykv.get(key);
			if (!row) {
				throw new Error(`Row "${rowId}" not found in table "${tableId}"`);
			}
			if (row.deletedAt === null) {
				return; // Already active
			}
			ykv.set(key, { ...row, deletedAt: null });
		},

		observe(handler: ChangeHandler<RowMeta>): () => void {
			const wrappedHandler = (
				changes: Map<
					string,
					{ action: string; oldValue?: RowMeta; newValue?: RowMeta }
				>,
				transaction: Y.Transaction,
			) => {
				const events: ChangeEvent<RowMeta>[] = [];
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
