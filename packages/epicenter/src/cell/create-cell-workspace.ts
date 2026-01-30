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
import { defineExports, type Lifecycle } from '../core/lifecycle';
import type { YKeyValueLwwEntry } from '../core/utils/y-keyvalue-lww';
import type {
	CellExtensionContext,
	CellExtensionFactoryMap,
	CellWorkspaceBuilder,
	InferCellExtensionExports,
} from './extensions';
import { validateId } from './keys';
import { getFieldById, getTableById } from './schema-file';
import { createKvStore, KV_ARRAY_NAME } from './stores/kv-store';
import { createTableHelper } from './table-helper';
import type {
	CellValue,
	CellWorkspaceClient,
	CreateCellWorkspaceOptions,
	CreateCellWorkspaceWithHeadDocOptions,
	FieldType,
	RowData,
	SchemaTableDefinition,
	TableHelper,
	TypedCell,
	TypedRowWithCells,
} from './types';

/**
 * Validate that a value matches the expected field type.
 * Returns true if the value is valid for the type, false otherwise.
 */
function validateCellType(value: CellValue, type: FieldType): boolean {
	if (value === null || value === undefined) {
		return true; // null/undefined is valid for all types
	}

	switch (type) {
		case 'id':
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
			// Accept string (ISO format) or number (timestamp)
			return typeof value === 'string' || typeof value === 'number';

		case 'select':
			return typeof value === 'string';

		case 'tags':
			return Array.isArray(value) && value.every((v) => typeof v === 'string');

		case 'json':
			// Any JSON-serializable value is valid
			return true;

		default:
			return true; // Unknown types pass validation
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Legacy API (id-based)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a cell workspace client (legacy API).
 *
 * @deprecated Use the HeadDoc-based API instead:
 * ```ts
 * const workspace = createCellWorkspace({ headDoc, definition })
 *   .withExtensions({ ... });
 * ```
 *
 * @example Legacy usage
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
 * ```
 */
export function createCellWorkspace(
	options: CreateCellWorkspaceOptions,
): CellWorkspaceClient;

/**
 * Create a cell workspace client with HeadDoc integration.
 *
 * This is the preferred API that integrates with the HeadDoc epoch system.
 * The Y.Doc guid will be `{workspaceId}-{epoch}` for time-travel support.
 *
 * Returns a builder that allows adding extensions with typed context.
 *
 * @example
 * ```ts
 * const headDoc = createHeadDoc({
 *   workspaceId: 'my-workspace',
 *   providers: { persistence },
 * });
 *
 * await headDoc.whenSynced;
 *
 * const workspace = createCellWorkspace({
 *   headDoc,
 *   definition: {
 *     name: 'My Blog',
 *     tables: [
 *       table({
 *         id: 'posts',
 *         name: 'Posts',
 *         fields: [id(), text({ id: 'title' }), integer({ id: 'views' })],
 *       }),
 *     ],
 *     kv: [],
 *   },
 * })
 *   .withExtensions({
 *     sqlite: (ctx) => {
 *       // ctx.table('posts') is typed!
 *       const posts = ctx.table('posts');
 *       return defineExports({ db: ... });
 *     },
 *   });
 *
 * await workspace.whenSynced;
 * // workspace.extensions.sqlite.db is typed
 * ```
 */
export function createCellWorkspace(
	options: CreateCellWorkspaceWithHeadDocOptions,
): CellWorkspaceBuilder;

export function createCellWorkspace(
	options: CreateCellWorkspaceOptions | CreateCellWorkspaceWithHeadDocOptions,
): CellWorkspaceClient | CellWorkspaceBuilder {
	// Detect which API is being used
	if ('headDoc' in options) {
		return createCellWorkspaceWithHeadDoc(options);
	}

	// Legacy API
	return createCellWorkspaceLegacy(options);
}

/**
 * Legacy implementation (id-based, no extensions).
 */
function createCellWorkspaceLegacy({
	id,
	definition,
	ydoc: existingYdoc,
}: CreateCellWorkspaceOptions): CellWorkspaceClient {
	// Create or use existing Y.Doc
	const ydoc = existingYdoc ?? new Y.Doc({ guid: id });

	// Extract metadata from definition
	const name = definition.name;
	const description = definition.description ?? '';
	const icon = definition.icon ?? null;

	// Cache table stores to avoid recreation
	const tableHelperCache = new Map<string, TableHelper>();

	// Initialize KV store
	const kvArray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_ARRAY_NAME);
	const kv = createKvStore(kvArray);

	const client: CellWorkspaceClient = {
		id,
		epoch: 0,
		ydoc,
		name,
		description,
		icon,
		definition,
		kv,
		extensions: {},
		whenSynced: Promise.resolve(),

		/**
		 * Get or create a table store.
		 * Passes schema from definition, or empty schema for dynamic tables.
		 */
		table(tableId: string): TableHelper {
			validateId(tableId, 'tableId');

			let store = tableHelperCache.get(tableId);
			if (!store) {
				// Use ydoc.getArray() - this creates a named shared type that merges correctly on sync
				const yarray = ydoc.getArray<YKeyValueLwwEntry<CellValue>>(tableId);
				// Use schema from definition, or empty schema for dynamic tables
				const tableSchema = getTableById(definition.tables, tableId) ?? {
					id: tableId,
					name: tableId,
					description: '',
					icon: null,
					fields: [],
				};
				store = createTableHelper(tableId, yarray, tableSchema);
				tableHelperCache.set(tableId, store);
			}
			return store;
		},

		/**
		 * Get rows with typed cells validated against schema.
		 * Uses the table schema from the definition.
		 */
		getTypedRows(tableId: string): TypedRowWithCells[] {
			const tableSchema = getTableById(definition.tables, tableId);
			const tableStore = this.table(tableId);
			// Get all rows (regardless of validation status) and extract RowData
			const results = tableStore.getAll();
			const rows: RowData[] = results.map((r) =>
				r.status === 'valid'
					? r.row
					: { id: r.id, cells: r.row as Record<string, CellValue> },
			);

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

			const schemaFieldIds = tableSchema.fields.map((f) => f.id);

			return rows.map((r) => {
				const typedCells: Record<string, TypedCell> = {};
				const dataFieldIds = Object.keys(r.cells);

				// Process cells that exist in data
				for (const [fieldId, value] of Object.entries(r.cells)) {
					const fieldSchema = getFieldById(tableSchema, fieldId);
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
				const missingFields = schemaFieldIds.filter((fid) => !(fid in r.cells));

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
		},

		batch<T>(fn: (ws: CellWorkspaceClient) => T): T {
			// Note: Currently does NOT wrap in a Yjs transaction due to a bug in
			// YKeyValueLww where entries added inside a wrapping transaction are
			// incorrectly deleted by the observer when the transaction completes.
			// This means observers may fire multiple times instead of once.
			//
			// TODO: Fix YKeyValueLww observer to properly handle nested transactions,
			// then re-enable: `return ydoc.transact(() => fn(this));`
			return fn(this);
		},

		async destroy(): Promise<void> {
			ydoc.destroy();
		},
	};

	return client;
}

// ════════════════════════════════════════════════════════════════════════════
// HeadDoc-based API (new)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Create a cell workspace with HeadDoc integration.
 * Returns a builder for adding extensions.
 */
function createCellWorkspaceWithHeadDoc({
	headDoc,
	definition,
}: CreateCellWorkspaceWithHeadDocOptions): CellWorkspaceBuilder {
	const workspaceId = headDoc.workspaceId;
	const epoch = headDoc.getEpoch();

	// Doc ID includes epoch for time-travel support
	const docId = `${workspaceId}-${epoch}`;
	const ydoc = new Y.Doc({ guid: docId, gc: false });

	// Extract metadata from definition
	const name = definition.name;
	const description = definition.description ?? '';
	const icon = definition.icon ?? null;

	// Cache table stores to avoid recreation
	const tableHelperCache = new Map<string, TableHelper>();

	// Initialize KV store
	const kvArray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_ARRAY_NAME);
	const kv = createKvStore(kvArray);

	/**
	 * Get or create a table store.
	 */
	function table(tableId: string): TableHelper {
		validateId(tableId, 'tableId');

		let store = tableHelperCache.get(tableId);
		if (!store) {
			const yarray = ydoc.getArray<YKeyValueLwwEntry<CellValue>>(tableId);
			// Use schema from definition, or empty schema for dynamic tables
			const tableSchema = getTableById(definition.tables, tableId) ?? {
				id: tableId,
				name: tableId,
				description: '',
				icon: null,
				fields: [],
			};
			store = createTableHelper(tableId, yarray, tableSchema);
			tableHelperCache.set(tableId, store);
		}
		return store;
	}

	return {
		withExtensions<TExtensions extends CellExtensionFactoryMap>(
			extensionFactories: TExtensions,
		): CellWorkspaceClient<
			readonly SchemaTableDefinition[],
			InferCellExtensionExports<TExtensions>
		> {
			// Initialize extensions with typed context
			const extensions = {} as InferCellExtensionExports<TExtensions>;

			for (const [extensionId, factory] of Object.entries(extensionFactories)) {
				const context: CellExtensionContext = {
					ydoc,
					workspaceId,
					epoch,
					table,
					kv,
					definition,
					extensionId,
				};
				(extensions as Record<string, unknown>)[extensionId] = defineExports(
					factory(context),
				);
			}

			// Aggregate whenSynced from all extensions
			const whenSynced = Promise.all(
				Object.values(extensions).map((e) => (e as Lifecycle).whenSynced),
			).then(() => {});

			const client: CellWorkspaceClient<
				readonly SchemaTableDefinition[],
				InferCellExtensionExports<TExtensions>
			> = {
				id: workspaceId,
				epoch,
				ydoc,
				name,
				description,
				icon,
				definition,
				table,
				kv,
				extensions,
				whenSynced,

				/**
				 * Get rows with typed cells validated against schema.
				 */
				getTypedRows(tableId: string): TypedRowWithCells[] {
					const tableSchema = getTableById(definition.tables, tableId);
					const tableStore = this.table(tableId);
					// Get all rows (regardless of validation status) and extract RowData
					const results = tableStore.getAll();
					const rows: RowData[] = results.map((r) =>
						r.status === 'valid'
							? r.row
							: { id: r.id, cells: r.row as Record<string, CellValue> },
					);

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

					const schemaFieldIds = tableSchema.fields.map((f) => f.id);

					return rows.map((r) => {
						const typedCells: Record<string, TypedCell> = {};
						const dataFieldIds = Object.keys(r.cells);

						for (const [fieldId, value] of Object.entries(r.cells)) {
							const fieldSchema = getFieldById(tableSchema, fieldId);
							if (fieldSchema) {
								typedCells[fieldId] = {
									value,
									type: fieldSchema.type,
									valid: validateCellType(value, fieldSchema.type),
								};
							} else {
								typedCells[fieldId] = {
									value,
									type: 'json',
									valid: true,
								};
							}
						}

						const missingFields = schemaFieldIds.filter(
							(fid) => !(fid in r.cells),
						);
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
				},

				batch<T>(
					fn: (
						ws: CellWorkspaceClient<
							readonly SchemaTableDefinition[],
							InferCellExtensionExports<TExtensions>
						>,
					) => T,
				): T {
					return fn(this);
				},

				async destroy(): Promise<void> {
					await Promise.allSettled(
						Object.values(extensions).map((e) => (e as Lifecycle).destroy()),
					);
					ydoc.destroy();
				},
			};

			return client;
		},
	};
}
