/**
 * Rows Store for Cell Workspace
 *
 * Stores row metadata (order, deletedAt) in Y.Doc using YKeyValueLww.
 * Row keys: `{tableId}:{rowId}`
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import {
	YKeyValueLww,
	type YKeyValueLwwEntry,
} from '../../core/utils/y-keyvalue-lww';
import type { RowMeta, RowsStore, ChangeHandler, ChangeEvent } from '../types';
import {
	rowKey,
	parseRowKey,
	tablePrefix,
	hasPrefix,
	validateId,
	generateRowId,
} from '../keys';

/**
 * Y.Array name for rows store.
 */
export const ROWS_ARRAY_NAME = 'cell:rows';

/**
 * Create a rows store backed by YKeyValueLww.
 */
export function createRowsStore(
	yarray: Y.Array<YKeyValueLwwEntry<RowMeta>>,
): RowsStore {
	const ykv = new YKeyValueLww<RowMeta>(yarray);

	function get(tableId: string, rowId: string): RowMeta | undefined {
		return ykv.get(rowKey(tableId, rowId));
	}

	function set(tableId: string, rowId: string, meta: RowMeta): void {
		validateId(tableId, 'tableId');
		validateId(rowId, 'rowId');
		ykv.set(rowKey(tableId, rowId), meta);
	}

	function del(tableId: string, rowId: string): void {
		const meta = get(tableId, rowId);
		if (meta && meta.deletedAt === null) {
			set(tableId, rowId, { ...meta, deletedAt: Date.now() });
		}
	}

	function has(tableId: string, rowId: string): boolean {
		return ykv.has(rowKey(tableId, rowId));
	}

	function getByTable(tableId: string): Array<{ id: string; meta: RowMeta }> {
		const prefix = tablePrefix(tableId);
		const results: Array<{ id: string; meta: RowMeta }> = [];

		for (const [key, entry] of ykv.map) {
			if (hasPrefix(key, prefix)) {
				const { rowId } = parseRowKey(key);
				results.push({ id: rowId, meta: entry.val });
			}
		}

		// Sort by order, then by ID for deterministic ordering
		return results.sort((a, b) => {
			if (a.meta.order !== b.meta.order) return a.meta.order - b.meta.order;
			return a.id.localeCompare(b.id);
		});
	}

	function getActiveByTable(
		tableId: string,
	): Array<{ id: string; meta: RowMeta }> {
		return getByTable(tableId).filter((r) => r.meta.deletedAt === null);
	}

	function create(tableId: string, rowId?: string, order?: number): string {
		validateId(tableId, 'tableId');

		const id = rowId ?? generateRowId();
		if (rowId) validateId(rowId, 'rowId');

		// Auto-calculate order if not provided (append to end)
		let finalOrder = order;
		if (finalOrder === undefined) {
			const existing = getActiveByTable(tableId);
			finalOrder =
				existing.length > 0
					? Math.max(...existing.map((r) => r.meta.order)) + 1
					: 1;
		}

		set(tableId, id, { order: finalOrder, deletedAt: null });
		return id;
	}

	function reorder(tableId: string, rowId: string, newOrder: number): void {
		const meta = get(tableId, rowId);
		if (meta) {
			set(tableId, rowId, { ...meta, order: newOrder });
		}
	}

	function restore(tableId: string, rowId: string): void {
		const meta = get(tableId, rowId);
		if (meta && meta.deletedAt !== null) {
			set(tableId, rowId, { ...meta, deletedAt: null });
		}
	}

	function observe(handler: ChangeHandler<RowMeta>): () => void {
		const ykvHandler = (
			changes: Map<string, import('../../core/utils/y-keyvalue-lww').YKeyValueLwwChange<RowMeta>>,
			transaction: Y.Transaction,
		) => {
			const events: ChangeEvent<RowMeta>[] = [];

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
		getByTable,
		getActiveByTable,
		create,
		reorder,
		restore,
		observe,
	};
}
