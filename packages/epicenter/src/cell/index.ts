/**
 * CellWorkspace - External Schema Architecture
 *
 * A simplified workspace implementation where:
 * - Schema is stored externally as JSON (not in Y.Doc)
 * - Only raw cell data is stored in the CRDT
 * - Schema is advisory (no enforcement, just type hints)
 *
 * File structure:
 * ```
 * {workspaceId}.json        # Schema definitions (local only)
 * {workspaceId}/
 *   workspace.yjs           # CRDT data (synced)
 * ```
 *
 * @packageDocumentation
 */

// Factory
export { createCellWorkspace } from './create-cell-workspace';

// Types
export type {
	// Schema types (external JSON)
	FieldType,
	SchemaFieldDefinition,
	SchemaTableDefinition,
	SchemaKvDefinition,
	WorkspaceSchema,
	// Data types (Y.Doc)
	CellValue,
	RowMeta,
	// Store interfaces
	RowsStore,
	CellsStore,
	KvStore,
	// Helper types
	RowWithCells,
	TypedCell,
	TypedRowWithCells,
	// Workspace client
	CellWorkspaceClient,
	CreateCellWorkspaceOptions,
	// Events
	ChangeEvent,
	ChangeHandler,
} from './types';

// Key utilities (useful for observers that receive raw keys)
export {
	generateRowId,
	validateId,
	rowKey,
	cellKey,
	parseRowKey,
	parseCellKey,
	tablePrefix,
	rowCellPrefix,
	hasPrefix,
	extractAfterPrefix,
} from './keys';

// Store array names (for advanced use cases like persistence providers)
export { ROWS_ARRAY_NAME } from './stores/rows-store';
export { CELLS_ARRAY_NAME } from './stores/cells-store';
export { KV_ARRAY_NAME } from './stores/kv-store';

// Schema file utilities
export {
	parseSchema,
	stringifySchema,
	createEmptySchema,
	addTable,
	removeTable,
	addField,
	removeField,
	getSortedFields,
	getNextFieldOrder,
} from './schema-file';
