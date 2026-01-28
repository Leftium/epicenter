/**
 * CellWorkspace Factory
 *
 * Creates a simplified workspace client with external schema support.
 *
 * Key differences from DynamicWorkspace:
 * - No schema stored in Y.Doc (schema is external JSON)
 * - Only three stores: rows, cells, kv
 * - Schema is advisory - validated on read, not enforced
 *
 * Y.Doc structure:
 * ```
 * Y.Doc
 * ├── Y.Array('cell:rows')   ← Row metadata (order, deletedAt)
 * ├── Y.Array('cell:cells')  ← Cell values
 * └── Y.Array('cell:kv')     ← Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../core/utils/y-keyvalue-lww';
import type {
	CellWorkspaceClient,
	CreateCellWorkspaceOptions,
	RowMeta,
	CellValue,
	RowWithCells,
	TypedRowWithCells,
	TypedCell,
	SchemaTableDefinition,
	FieldType,
} from './types';
import { createRowsStore, ROWS_ARRAY_NAME } from './stores/rows-store';
import { createCellsStore, CELLS_ARRAY_NAME } from './stores/cells-store';
import { createKvStore, KV_ARRAY_NAME } from './stores/kv-store';

/**
 * Validate that a value matches the expected field type.
 * Returns true if the value is valid for the type, false otherwise.
 */
function validateCellType(value: CellValue, type: FieldType): boolean {
	if (value === null || value === undefined) {
		return true; // null/undefined is valid for all types
	}

	switch (type) {
		case 'text':
		case 'richtext':
			return typeof value === 'string';

		case 'integer':
			return typeof value === 'number' && Number.isInteger(value);

		case 'real':
			return typeof value === 'number';

		case 'boolean':
			return typeof value === 'boolean';

		case 'date':
		case 'datetime':
			// Accept string (ISO format) or number (timestamp)
			return typeof value === 'string' || typeof value === 'number';

		case 'select':
			return typeof value === 'string';

		case 'tags':
			return (
				Array.isArray(value) && value.every((v) => typeof v === 'string')
			);

		case 'json':
			// Any JSON-serializable value is valid
			return true;

		default:
			return true; // Unknown types pass validation
	}
}

/**
 * Create a cell workspace client.
 *
 * @example
 * ```ts
 * const workspace = createCellWorkspace({ id: 'my-workspace' });
 *
 * // Create a row
 * const rowId = workspace.rows.create('posts');
 *
 * // Set cells (no schema enforcement)
 * workspace.cells.set('posts', rowId, 'title', 'Hello World');
 * workspace.cells.set('posts', rowId, 'views', 100);
 *
 * // Read back
 * const rows = workspace.getRowsWithCells('posts');
 * // [{ id: 'abc123', order: 1, deletedAt: null, cells: { title: 'Hello World', views: 100 } }]
 * ```
 */
export function createCellWorkspace(
	options: CreateCellWorkspaceOptions,
): CellWorkspaceClient {
	const { id, ydoc: existingYdoc } = options;

	// Create or use existing Y.Doc
	const ydoc = existingYdoc ?? new Y.Doc({ guid: id });

	// Initialize Y.Arrays
	const rowsArray = ydoc.getArray<YKeyValueLwwEntry<RowMeta>>(ROWS_ARRAY_NAME);
	const cellsArray =
		ydoc.getArray<YKeyValueLwwEntry<CellValue>>(CELLS_ARRAY_NAME);
	const kvArray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_ARRAY_NAME);

	// Create stores
	const rows = createRowsStore(rowsArray);
	const cells = createCellsStore(cellsArray);
	const kv = createKvStore(kvArray);

	// Helper methods
	function getRowsWithCells(tableId: string): RowWithCells[] {
		const activeRows = rows.getActiveByTable(tableId);

		return activeRows.map((r) => {
			const rowCells = cells.getByRow(tableId, r.id);
			const cellsRecord: Record<string, CellValue> = {};
			for (const [fieldId, value] of rowCells) {
				cellsRecord[fieldId] = value;
			}

			return {
				id: r.id,
				order: r.meta.order,
				deletedAt: r.meta.deletedAt,
				cells: cellsRecord,
			};
		});
	}

	function getTypedRowsWithCells(
		tableId: string,
		tableSchema: SchemaTableDefinition,
	): TypedRowWithCells[] {
		const activeRows = rows.getActiveByTable(tableId);
		const schemaFieldIds = Object.keys(tableSchema.fields);

		return activeRows.map((r) => {
			const rowCells = cells.getByRow(tableId, r.id);
			const typedCells: Record<string, TypedCell> = {};
			const dataFieldIds = Array.from(rowCells.keys());

			// Process cells that exist in data
			for (const [fieldId, value] of rowCells) {
				const fieldSchema = tableSchema.fields[fieldId];
				if (fieldSchema) {
					typedCells[fieldId] = {
						value,
						type: fieldSchema.type,
						valid: validateCellType(value, fieldSchema.type),
					};
				} else {
					// Field exists in data but not in schema - mark as 'json' (unknown)
					typedCells[fieldId] = {
						value,
						type: 'json',
						valid: true,
					};
				}
			}

			// Find missing fields (in schema but not in data)
			const missingFields = schemaFieldIds.filter(
				(id) => !rowCells.has(id),
			);

			// Find extra fields (in data but not in schema)
			const extraFields = dataFieldIds.filter(
				(id) => !schemaFieldIds.includes(id),
			);

			return {
				id: r.id,
				order: r.meta.order,
				deletedAt: r.meta.deletedAt,
				cells: typedCells,
				missingFields,
				extraFields,
			};
		});
	}

	function batch<T>(fn: (ws: CellWorkspaceClient) => T): T {
		// Note: Currently does NOT wrap in a Yjs transaction due to a bug in
		// YKeyValueLww where entries added inside a wrapping transaction are
		// incorrectly deleted by the observer when the transaction completes.
		// This means observers may fire multiple times instead of once.
		//
		// TODO: Fix YKeyValueLww observer to properly handle nested transactions,
		// then re-enable: `return ydoc.transact(() => fn(client));`
		return fn(client);
	}

	async function destroy(): Promise<void> {
		ydoc.destroy();
	}

	const client: CellWorkspaceClient = {
		id,
		ydoc,
		rows,
		cells,
		kv,
		getRowsWithCells,
		getTypedRowsWithCells,
		batch,
		destroy,
	};

	return client;
}
