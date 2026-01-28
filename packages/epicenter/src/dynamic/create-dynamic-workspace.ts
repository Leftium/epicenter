/**
 * Dynamic Workspace Factory
 *
 * Creates a DynamicWorkspaceClient with all stores initialized
 * and high-level helper methods for common operations.
 *
 * @packageDocumentation
 */

import * as Y from 'yjs';
import { YKeyValueLww } from '../core/utils/y-keyvalue-lww.js';
import type {
	CellValue,
	CreateDynamicWorkspaceOptions,
	DynamicWorkspaceClient,
	FieldDefinition,
	RowMeta,
	RowWithCells,
	TableDefinition,
	TableWithFields,
} from './types.js';
import { createTablesStore } from './stores/tables-store.js';
import { createFieldsStore } from './stores/fields-store.js';
import { createRowsStore } from './stores/rows-store.js';
import { createCellsStore } from './stores/cells-store.js';

/**
 * Y.Array names for dynamic workspace storage.
 * Prefixed with 'dynamic:' to avoid collision with static workspace arrays.
 */
const ARRAY_NAMES = {
	tables: 'dynamic:tables',
	fields: 'dynamic:fields',
	rows: 'dynamic:rows',
	cells: 'dynamic:cells',
} as const;

/**
 * Create a new dynamic workspace client.
 *
 * The dynamic workspace provides runtime-editable schemas (Notion-like databases)
 * with cell-level CRDT granularity using YKeyValueLww.
 *
 * @param options - Configuration options
 * @param options.id - Unique identifier for the workspace (used as Y.Doc guid)
 * @param options.ydoc - Optional existing Y.Doc to use instead of creating new
 *
 * @returns A fully initialized DynamicWorkspaceClient
 *
 * @example
 * ```typescript
 * import { createDynamicWorkspace } from '@epicenter/hq/dynamic';
 *
 * const workspace = createDynamicWorkspace({ id: 'my-workspace' });
 *
 * // Create a table
 * workspace.tables.create('posts', { name: 'Blog Posts', icon: '📝' });
 *
 * // Add fields
 * workspace.fields.create('posts', 'title', { name: 'Title', type: 'text' });
 * workspace.fields.create('posts', 'published', { name: 'Published', type: 'boolean' });
 *
 * // Add a row and set cell values
 * const rowId = workspace.rows.create('posts');
 * workspace.cells.set('posts', rowId, 'title', 'Hello World');
 *
 * // Read table with all data
 * const table = workspace.getTableWithFields('posts');
 * const rows = workspace.getRowsWithCells('posts');
 *
 * // Cleanup
 * await workspace.destroy();
 * ```
 */
export function createDynamicWorkspace(
	options: CreateDynamicWorkspaceOptions,
): DynamicWorkspaceClient {
	// Use provided Y.Doc or create a new one with the workspace ID as guid
	const ydoc = options.ydoc ?? new Y.Doc({ guid: options.id });

	// Initialize Y.Arrays (Y.Doc returns existing if already present)
	const tablesArray = ydoc.getArray<{ key: string; val: TableDefinition; ts: number }>(
		ARRAY_NAMES.tables,
	);
	const fieldsArray = ydoc.getArray<{ key: string; val: FieldDefinition; ts: number }>(
		ARRAY_NAMES.fields,
	);
	const rowsArray = ydoc.getArray<{ key: string; val: RowMeta; ts: number }>(
		ARRAY_NAMES.rows,
	);
	const cellsArray = ydoc.getArray<{ key: string; val: CellValue; ts: number }>(
		ARRAY_NAMES.cells,
	);

	// Wrap with YKeyValueLww for LWW conflict resolution
	const tablesKv = new YKeyValueLww(tablesArray);
	const fieldsKv = new YKeyValueLww(fieldsArray);
	const rowsKv = new YKeyValueLww(rowsArray);
	const cellsKv = new YKeyValueLww(cellsArray);

	// Create store wrappers
	const tables = createTablesStore(tablesKv);
	const fields = createFieldsStore(fieldsKv);
	const rows = createRowsStore(rowsKv);
	const cells = createCellsStore(cellsKv);

	/**
	 * Get a table with all its active field definitions.
	 */
	function getTableWithFields(tableId: string): TableWithFields | null {
		const table = tables.get(tableId);
		if (!table || table.deletedAt !== null) {
			return null;
		}

		const activeFields = fields.getActiveByTable(tableId);

		return {
			id: tableId,
			name: table.name,
			icon: table.icon ?? null,
			deletedAt: table.deletedAt,
			fields: activeFields.map(({ id, field }) => ({
				id,
				name: field.name,
				type: field.type,
				order: field.order,
				icon: field.icon ?? null,
				options: field.options,
				default: field.default,
			})),
		};
	}

	/**
	 * Get all active rows for a table with their cell values.
	 */
	function getRowsWithCells(tableId: string): RowWithCells[] {
		// Get active field IDs for efficient cell lookups
		const activeFields = fields.getActiveByTable(tableId);
		const fieldIds = activeFields.map((f) => f.id);

		// Get active rows
		const activeRows = rows.getActiveByTable(tableId);

		// Build result with cells
		return activeRows.map(({ id, meta }) => {
			const cellMap = cells.getByRow(tableId, id, fieldIds);

			// Convert Map to Record
			const cellsRecord: Record<string, CellValue> = {};
			for (const [fieldId, value] of cellMap) {
				cellsRecord[fieldId] = value;
			}

			return {
				id,
				order: meta.order,
				deletedAt: meta.deletedAt,
				cells: cellsRecord,
			};
		});
	}

	// Create the client object with a placeholder for batch
	const client = {
		id: options.id,
		ydoc,
		tables,
		fields,
		rows,
		cells,
		getTableWithFields,
		getRowsWithCells,
		/**
		 * Execute multiple operations as a logical batch.
		 *
		 * Note: Currently does NOT wrap in a Yjs transaction due to a bug in
		 * YKeyValueLww where entries added inside a wrapping transaction are
		 * incorrectly deleted by the observer when the transaction completes.
		 * This means observers may fire multiple times instead of once.
		 *
		 * TODO: Fix YKeyValueLww observer to properly handle nested transactions,
		 * then re-enable: `return ydoc.transact(() => fn(client));`
		 */
		batch<T>(fn: (ws: DynamicWorkspaceClient) => T): T {
			return fn(client);
		},
		/**
		 * Destroy the workspace and release resources.
		 */
		async destroy(): Promise<void> {
			// Y.Doc doesn't need explicit cleanup, but we provide this
			// for consistency and future extensibility (e.g., sync providers)
			ydoc.destroy();
		},
	} satisfies DynamicWorkspaceClient;

	return client;
}
