/**
 * TablesStore - Store for dynamic table definitions
 *
 * Wraps YKeyValueLww to provide table-specific operations with
 * soft delete support via tombstones.
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import { YKeyValueLww } from '../../core/utils/y-keyvalue-lww.js';
import type { ChangeEvent, ChangeHandler, TableDefinition, TablesStore } from '../types.js';
import { validateId } from '../keys.js';

/**
 * Create a TablesStore wrapping a YKeyValueLww instance.
 *
 * @param ykv - The YKeyValueLww instance to wrap
 * @returns A TablesStore implementation
 */
export function createTablesStore(
	ykv: YKeyValueLww<TableDefinition>,
): TablesStore {
	return {
		get(tableId: string): TableDefinition | undefined {
			return ykv.get(tableId);
		},

		set(tableId: string, table: TableDefinition): void {
			validateId(tableId, 'tableId');
			ykv.set(tableId, table);
		},

		delete(tableId: string): void {
			const table = ykv.get(tableId);
			if (table && table.deletedAt === null) {
				ykv.set(tableId, { ...table, deletedAt: Date.now() });
			}
		},

		has(tableId: string): boolean {
			return ykv.has(tableId);
		},

		getAll(): Map<string, TableDefinition> {
			const result = new Map<string, TableDefinition>();
			// Use entries() to include both pending and confirmed entries
			for (const [key, entry] of ykv.entries()) {
				result.set(key, entry.val);
			}
			return result;
		},

		getActive(): Map<string, TableDefinition> {
			const result = new Map<string, TableDefinition>();
			// Use entries() to include both pending and confirmed entries
			for (const [key, entry] of ykv.entries()) {
				if (entry.val.deletedAt === null) {
					result.set(key, entry.val);
				}
			}
			return result;
		},

		create(
			tableId: string,
			options: { name: string; icon?: string | null },
		): void {
			validateId(tableId, 'tableId');
			if (ykv.has(tableId)) {
				throw new Error(`Table "${tableId}" already exists`);
			}
			ykv.set(tableId, {
				name: options.name,
				deletedAt: null,
				icon: options.icon ?? null,
			});
		},

		rename(tableId: string, newName: string): void {
			const table = ykv.get(tableId);
			if (!table) {
				throw new Error(`Table "${tableId}" not found`);
			}
			ykv.set(tableId, { ...table, name: newName });
		},

		restore(tableId: string): void {
			const table = ykv.get(tableId);
			if (!table) {
				throw new Error(`Table "${tableId}" not found`);
			}
			if (table.deletedAt === null) {
				return; // Already active
			}
			ykv.set(tableId, { ...table, deletedAt: null });
		},

		observe(handler: ChangeHandler<TableDefinition>): () => void {
			const wrappedHandler = (
				changes: Map<string, { action: string; oldValue?: TableDefinition; newValue?: TableDefinition }>,
				transaction: Y.Transaction,
			) => {
				const events: ChangeEvent<TableDefinition>[] = [];
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
					} else if (change.action === 'delete' && change.oldValue !== undefined) {
						events.push({ type: 'delete', key, previousValue: change.oldValue });
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
