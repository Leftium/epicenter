/**
 * CellWorkspace Factory
 *
 * Creates a simplified workspace client with external schema support.
 *
 * Architecture (Option B):
 * - One Y.Array per table, accessed via `ydoc.getArray(tableId)`
 * - Every entry is a cell value
 * - Schema is external (JSON file), not in Y.Doc
 * - KV store uses a separate Y.Array
 *
 * Y.Doc structure:
 * ```
 * Y.Doc
 * ├── Y.Array('posts')    ← Table data (cells only)
 * ├── Y.Array('users')    ← Another table
 * └── Y.Array('kv')       ← Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

import * as Y from 'yjs';
import type { YKeyValueLwwEntry } from '../core/utils/y-keyvalue-lww';
import type {
	CellWorkspaceClient,
	CreateCellWorkspaceOptions,
	CellValue,
	TypedRowWithCells,
	TypedCell,
	FieldType,
	TableStore,
} from './types';
import { createTableStore } from './table-store';
import { createKvStore, KV_ARRAY_NAME } from './stores/kv-store';
import { validateId } from './keys';
import {
	createValidatedTableStore,
	type ValidatedTableStore,
} from './validated-table-store';

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
 * const workspace = createCellWorkspace({
 *   id: 'my-workspace',
 *   definition: {
 *     name: 'My Blog',
 *     tables: {
 *       posts: {
 *         name: 'Posts',
 *         fields: {
 *           title: { name: 'Title', type: 'text', order: 1 },
 *           views: { name: 'Views', type: 'integer', order: 2 },
 *         }
 *       }
 *     }
 *   }
 * });
 *
 * // Get a table store
 * const posts = workspace.table('posts');
 *
 * // Create a row
 * const rowId = posts.createRow();
 *
 * // Set cells
 * posts.set(rowId, 'title', 'Hello World');
 * posts.set(rowId, 'views', 100);
 *
 * // Read back
 * const rows = posts.getRows();
 * // [{ id: 'abc123', cells: { title: 'Hello World', views: 100 } }]
 *
 * // Get typed rows (uses definition's schema)
 * const typedRows = workspace.getTypedRows('posts');
 * ```
 */
export function createCellWorkspace(
	options: CreateCellWorkspaceOptions,
): CellWorkspaceClient {
	const { id, definition, ydoc: existingYdoc } = options;

	// Create or use existing Y.Doc
	const ydoc = existingYdoc ?? new Y.Doc({ guid: id });

	// Extract metadata from definition
	const name = definition.name;
	const description = definition.description ?? '';
	const icon = definition.icon ?? null;

	// Cache table stores to avoid recreation
	const tableStoreCache = new Map<string, TableStore>();

	// Cache validated table stores
	const validatedStoreCache = new Map<string, ValidatedTableStore>();

	// Initialize KV store
	const kvArray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_ARRAY_NAME);
	const kv = createKvStore(kvArray);

	/**
	 * Get or create a table store.
	 */
	function table(tableId: string): TableStore {
		validateId(tableId, 'tableId');

		let store = tableStoreCache.get(tableId);
		if (!store) {
			// Use ydoc.getArray() - this creates a named shared type that merges correctly on sync
			const yarray = ydoc.getArray<YKeyValueLwwEntry<CellValue>>(tableId);
			store = createTableStore(tableId, yarray);
			tableStoreCache.set(tableId, store);
		}
		return store;
	}

	/**
	 * Get rows with typed cells validated against schema.
	 * Uses the table schema from the definition.
	 */
	/**
	 * Get a validated table store with TypeBox validation.
	 * Returns undefined for tables not in the schema (dynamic tables).
	 */
	function validatedTable(tableId: string): ValidatedTableStore | undefined {
		const tableSchema = definition.tables[tableId];
		if (!tableSchema) {
			return undefined;
		}

		let validated = validatedStoreCache.get(tableId);
		if (!validated) {
			const tableStore = table(tableId);
			validated = createValidatedTableStore(tableId, tableSchema, tableStore);
			validatedStoreCache.set(tableId, validated);
		}
		return validated;
	}

	function getTypedRows(tableId: string): TypedRowWithCells[] {
		const tableSchema = definition.tables[tableId];
		const tableStore = table(tableId);
		const rows = tableStore.getRows();

		// If table not in schema, return rows with all fields marked as 'json'
		if (!tableSchema) {
			return rows.map((r) => {
				const typedCells: Record<string, TypedCell> = {};
				for (const [fieldId, value] of Object.entries(r.cells)) {
					typedCells[fieldId] = { value, type: 'json', valid: true };
				}
				return {
					id: r.id,
					cells: typedCells,
					missingFields: [],
					extraFields: Object.keys(r.cells),
				};
			});
		}

		const schemaFieldIds = Object.keys(tableSchema.fields);

		return rows.map((r) => {
			const typedCells: Record<string, TypedCell> = {};
			const dataFieldIds = Object.keys(r.cells);

			// Process cells that exist in data
			for (const [fieldId, value] of Object.entries(r.cells)) {
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
				(fid) => !(fid in r.cells),
			);

			// Find extra fields (in data but not in schema)
			const extraFields = dataFieldIds.filter(
				(fid) => !schemaFieldIds.includes(fid),
			);

			return {
				id: r.id,
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
		name,
		description,
		icon,
		definition,
		table,
		kv,
		getTypedRows,
		validatedTable,
		batch,
		destroy,
	};

	return client;
}
