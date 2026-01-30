/**
 * FieldsStore - Store for dynamic field definitions
 *
 * Wraps YKeyValueLww to provide field-specific operations with
 * composite keys (tableId:fieldId) and soft delete support.
 *
 * @packageDocumentation
 */

import type * as Y from 'yjs';
import type { YKeyValueLww } from '../../core/utils/y-keyvalue-lww.js';
import { fieldKey, parseFieldKey, tablePrefix, validateId } from '../keys.js';
import type {
	ChangeEvent,
	ChangeHandler,
	FieldDefinition,
	FieldsStore,
	FieldType,
} from '../types.js';

/**
 * Create a FieldsStore wrapping a YKeyValueLww instance.
 *
 * @param ykv - The YKeyValueLww instance to wrap
 * @returns A FieldsStore implementation
 */
export function createFieldsStore(
	ykv: YKeyValueLww<FieldDefinition>,
): FieldsStore {
	/**
	 * Calculate the next order value for a new field in a table.
	 * Returns max(existing orders) + 1, or 1 if no fields exist.
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
		get(tableId: string, fieldId: string): FieldDefinition | undefined {
			return ykv.get(fieldKey(tableId, fieldId));
		},

		set(tableId: string, fieldId: string, field: FieldDefinition): void {
			validateId(tableId, 'tableId');
			validateId(fieldId, 'fieldId');
			ykv.set(fieldKey(tableId, fieldId), field);
		},

		delete(tableId: string, fieldId: string): void {
			const key = fieldKey(tableId, fieldId);
			const field = ykv.get(key);
			if (field && field.deletedAt === null) {
				ykv.set(key, { ...field, deletedAt: Date.now() });
			}
		},

		has(tableId: string, fieldId: string): boolean {
			return ykv.has(fieldKey(tableId, fieldId));
		},

		getByTable(tableId: string): Array<{ id: string; field: FieldDefinition }> {
			const prefix = tablePrefix(tableId);
			const result: Array<{ id: string; field: FieldDefinition }> = [];

			// Use entries() to include both pending and confirmed entries
			for (const [key, entry] of ykv.entries()) {
				if (key.startsWith(prefix)) {
					const { fieldId } = parseFieldKey(key);
					result.push({ id: fieldId, field: entry.val });
				}
			}

			// Sort by order, then by field ID as tiebreaker
			return result.sort((a, b) => {
				if (a.field.order !== b.field.order) {
					return a.field.order - b.field.order;
				}
				return a.id.localeCompare(b.id);
			});
		},

		getActiveByTable(
			tableId: string,
		): Array<{ id: string; field: FieldDefinition }> {
			return this.getByTable(tableId).filter((f) => f.field.deletedAt === null);
		},

		create(
			tableId: string,
			fieldId: string,
			options: {
				name: string;
				type: FieldType;
				order?: number;
				icon?: string | null;
				options?: string[];
				default?: unknown;
			},
		): void {
			validateId(tableId, 'tableId');
			validateId(fieldId, 'fieldId');

			const key = fieldKey(tableId, fieldId);
			if (ykv.has(key)) {
				throw new Error(
					`Field "${fieldId}" already exists in table "${tableId}"`,
				);
			}

			const field: FieldDefinition = {
				name: options.name,
				type: options.type,
				order: options.order ?? getNextOrder(tableId),
				deletedAt: null,
				icon: options.icon ?? null,
			};

			if (options.options !== undefined) {
				field.options = options.options;
			}
			if (options.default !== undefined) {
				field.default = options.default;
			}

			ykv.set(key, field);
		},

		rename(tableId: string, fieldId: string, newName: string): void {
			const key = fieldKey(tableId, fieldId);
			const field = ykv.get(key);
			if (!field) {
				throw new Error(`Field "${fieldId}" not found in table "${tableId}"`);
			}
			ykv.set(key, { ...field, name: newName });
		},

		reorder(tableId: string, fieldId: string, newOrder: number): void {
			const key = fieldKey(tableId, fieldId);
			const field = ykv.get(key);
			if (!field) {
				throw new Error(`Field "${fieldId}" not found in table "${tableId}"`);
			}
			ykv.set(key, { ...field, order: newOrder });
		},

		restore(tableId: string, fieldId: string): void {
			const key = fieldKey(tableId, fieldId);
			const field = ykv.get(key);
			if (!field) {
				throw new Error(`Field "${fieldId}" not found in table "${tableId}"`);
			}
			if (field.deletedAt === null) {
				return; // Already active
			}
			ykv.set(key, { ...field, deletedAt: null });
		},

		observe(handler: ChangeHandler<FieldDefinition>): () => void {
			const wrappedHandler = (
				changes: Map<
					string,
					{
						action: string;
						oldValue?: FieldDefinition;
						newValue?: FieldDefinition;
					}
				>,
				transaction: Y.Transaction,
			) => {
				const events: ChangeEvent<FieldDefinition>[] = [];
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
