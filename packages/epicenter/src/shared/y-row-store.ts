/**
 * # YRowStore - Row Operations Wrapper over CellStore
 *
 * Provides row reconstruction, row deletion, and row-level observation.
 * Does NOT store anything itself - delegates to the underlying CellStore.
 *
 * ## Design Principles
 *
 * - Composition over features: Takes a CellStore as its only argument
 * - No setRow(): Write semantics are ambiguous (merge vs replace), use cells.batch()
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
 * // Write via cells (cell-level granularity)
 * cells.batch((tx) => {
 *   tx.setCell('post-1', 'title', 'Hello World');
 *   tx.setCell('post-1', 'views', 0);
 * });
 *
 * // Read via rows (reconstructed)
 * const post = rows.get('post-1');
 * // { title: 'Hello World', views: 0 }
 *
 * // Delete entire row
 * rows.delete('post-1');
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
	// ROW DELETE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Delete all cells for a row.
	 * Returns true if any cells existed.
	 * O(n) scan + k deletions where k = cells in row.
	 */
	delete(rowId: string): boolean;

	// ═══════════════════════════════════════════════════════════════════════
	// OBSERVE
	// ═══════════════════════════════════════════════════════════════════════

	/**
	 * Watch for row-level changes (deduplicated from cell changes).
	 * Callback receives Set of row IDs that had any cell change.
	 * Returns unsubscribe function.
	 */
	observe(handler: RowsChangedHandler): () => void;

	// ═══════════════════════════════════════════════════════════════════════
	// UNDERLYING STORE
	// ═══════════════════════════════════════════════════════════════════════

	/** The underlying CellStore for cell-level operations. */
	readonly cells: CellStore<T>;
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

		observe(handler) {
			return cellStore.observe((changes, transaction) => {
				const rowIds = new Set(changes.map((c) => c.rowId));
				if (rowIds.size > 0) {
					handler(rowIds, transaction);
				}
			});
		},

		cells: cellStore,
	};
}
