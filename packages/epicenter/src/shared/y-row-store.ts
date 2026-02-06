/**
 * # YRowStore - Row Operations Wrapper over CellStore
 *
 * Provides row reconstruction, row-level writes (merge), batch operations,
 * row deletion, and row-level observation.
 * Does NOT store anything itself - delegates to the underlying CellStore.
 *
 * ## Design Principles
 *
 * - Composition over features: Takes a CellStore as its only argument
 * - No setCell/deleteCell: Cell writes go through CellStore directly
 * - merge() for row-level writes: Clear semantics — merges fields, creates if missing
 * - Row operations use prefix scanning on the underlying ykv.map
 *
 * @example
 * ```typescript
 * import { createCellStore } from './y-cell-store.js';
 * import { createRowStore } from './y-row-store.js';
 *
 * const cells = createCellStore<unknown>(ydoc, 'table:posts');
 * const rows = createRowStore(cells);
 *
 * // Merge fields into a row (creates if missing, updates if present)
 * rows.merge('post-1', { title: 'Hello World', views: 0 });
 *
 * // Batch row operations (atomic, single observer notification)
 * rows.batch((tx) => {
 *   tx.merge('post-1', { title: 'Updated', views: 1 });
 *   tx.merge('post-2', { title: 'New Post' });
 *   tx.delete('post-3');
 * });
 *
 * // Read via rows (reconstructed)
 * const post = rows.get('post-1');
 * // { title: 'Updated', views: 1 }
 *
 * // Delete entire row
 * rows.delete('post-1');
 *
 * // Cell-level writes still go through CellStore
 * cells.setCell('post-2', 'draft', true);
 *
 * // Atomic mixed operations (Yjs transactions nest safely)
 * cells.doc.transact(() => {
 *   rows.merge('post-2', { title: 'Atomic' });
 *   cells.deleteCell('post-1', 'draft');
 *   rows.delete('post-3');
 * });
 * ```
 */
import type * as Y from 'yjs';
import type { CellStore } from './y-cell-store.js';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/** Handler for row-level change notifications (deduplicated from cells). */
export type RowsChangedHandler = (
	changedRowIds: Set<string>,
	transaction: Y.Transaction,
) => void;

/** Operations available inside a row batch transaction. */
export type RowStoreBatchTransaction<T> = {
	/** Merge fields into a row. Only touches columns present in data. */
	merge(rowId: string, data: Record<string, T>): void;
	/** Delete all cells for a row. */
	delete(rowId: string): void;
};

/** Row operations wrapper over CellStore. */
export type RowStore<T> = {
	// ═══════════════════════════════════════════════════════════════════════
	// ROW READ
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Reconstruct a row from its cells.
	 * Returns undefined if no cells exist for this row.
	 * O(n) where n = total cells in store.
	 */
	get(rowId: string): Record<string, T> | undefined;

	/** Check if any cells exist for a row. O(n) worst case, early-exits. */
	has(rowId: string): boolean;

	/** Get all row IDs that have at least one cell. O(n) with deduplication. */
	ids(): string[];

	/** Get all rows reconstructed from cells. O(n) single pass. */
	getAll(): Map<string, Record<string, T>>;

	/** Number of unique rows. */
	count(): number;

	// ═══════════════════════════════════════════════════════════════════════
	// ROW WRITE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Merge fields into a row. Only sets columns present in data.
	 * Creates the row if it doesn't exist.
	 * Leaves unmentioned columns untouched.
	 */
	merge(rowId: string, data: Record<string, T>): void;

	// ═══════════════════════════════════════════════════════════════════════
	// ROW DELETE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Delete all cells for a row.
	 * Returns true if any cells existed.
	 * O(n) scan + k deletions where k = cells in row.
	 */
	delete(rowId: string): boolean;

	// ═══════════════════════════════════════════════════════════════════════
	// BATCH
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Execute multiple row operations atomically in a Y.js transaction.
	 * - Single undo/redo step
	 * - Observers fire once (not per-operation)
	 * - Transaction has { merge, delete } — row-level operations only
	 */
	batch(fn: (tx: RowStoreBatchTransaction<T>) => void): void;

	// ═══════════════════════════════════════════════════════════════════════
	// OBSERVE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Watch for row-level changes (deduplicated from cell changes).
	 * Callback receives Set of row IDs that had any cell change.
	 * Returns unsubscribe function.
	 */
	observe(handler: RowsChangedHandler): () => void;

};

// ═══════════════════════════════════════════════════════════════════════════
// ROW UTILITIES (Private)
// ═══════════════════════════════════════════════════════════════════════════

const SEPARATOR = ':';

function rowPrefix(rowId: string): string {
	return `${rowId}${SEPARATOR}`;
}

function extractRowId(key: string): string {
	const idx = key.indexOf(SEPARATOR);
	return key.slice(0, idx);
}

// ═══════════════════════════════════════════════════════════════════════════
// FACTORY FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a row operations wrapper over an existing CellStore.
 *
 * @param cellStore - The CellStore to wrap
 */
export function createRowStore<T>(cellStore: CellStore<T>): RowStore<T> {
	const { ykv, doc } = cellStore;

	return {
		get(rowId) {
			const prefix = rowPrefix(rowId);
			const cells: Record<string, T> = {};
			let found = false;

			for (const [key, entry] of ykv.map) {
				if (key.startsWith(prefix)) {
					const columnId = key.slice(prefix.length);
					cells[columnId] = entry.val;
					found = true;
				}
			}

			return found ? cells : undefined;
		},

		has(rowId) {
			const prefix = rowPrefix(rowId);
			for (const key of ykv.map.keys()) {
				if (key.startsWith(prefix)) return true;
			}
			return false;
		},

		ids() {
			const seen = new Set<string>();
			for (const key of ykv.map.keys()) {
				seen.add(extractRowId(key));
			}
			return Array.from(seen);
		},

		getAll() {
			const rows = new Map<string, Record<string, T>>();

			for (const [key, entry] of ykv.map) {
				const rowId = extractRowId(key);
				const columnId = key.slice(rowId.length + 1); // +1 for separator

				const existing = rows.get(rowId) ?? {};
				existing[columnId] = entry.val;
				rows.set(rowId, existing);
			}

			return rows;
		},

		count() {
			const seen = new Set<string>();
			for (const key of ykv.map.keys()) {
				seen.add(extractRowId(key));
			}
			return seen.size;
		},

		merge(rowId, data) {
			doc.transact(() => {
				for (const [columnId, value] of Object.entries(data)) {
					cellStore.setCell(rowId, columnId, value);
				}
			});
		},

		delete(rowId) {
			const prefix = rowPrefix(rowId);
			const keysToDelete: string[] = [];

			for (const key of ykv.map.keys()) {
				if (key.startsWith(prefix)) {
					keysToDelete.push(key);
				}
			}

			if (keysToDelete.length === 0) return false;

			doc.transact(() => {
				for (const key of keysToDelete) {
					ykv.delete(key);
				}
			});

			return true;
		},

		batch(fn) {
			doc.transact(() => {
				fn({
					merge(rowId, data) {
						for (const [columnId, value] of Object.entries(data)) {
							cellStore.setCell(rowId, columnId, value);
						}
					},
					delete(rowId) {
						const prefix = rowPrefix(rowId);
						for (const key of ykv.map.keys()) {
							if (key.startsWith(prefix)) {
								ykv.delete(key);
							}
						}
					},
				});
			});
		},

		observe(handler) {
			return cellStore.observe((changes, transaction) => {
				const rowIds = new Set(changes.map((c) => c.rowId));
				if (rowIds.size > 0) {
					handler(rowIds, transaction);
				}
			});
		},
	};
}
