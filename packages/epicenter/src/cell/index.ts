/**
 * CellWorkspace - External Schema Architecture
 *
 * A simplified workspace implementation where:
 * - Schema is stored externally as JSON (not in Y.Doc)
 * - Only raw cell data is stored in the CRDT
 * - Schema is advisory (no enforcement, just type hints)
 *
 * Y.Doc structure (Option B - one Y.Array per table):
 * ```
 * Y.Doc
 * ├── Y.Array('posts')    ← Table data (cells + row metadata)
 * ├── Y.Array('users')    ← Another table
 * └── Y.Array('kv')       ← Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

// Factory
export { createCellWorkspace } from './create-cell-workspace';

// Table store factory (for advanced use)
export { createTableStore } from './table-store';

// Types
export type {
	// Schema types (external JSON)
	FieldType,
	SchemaFieldDefinition,
	SchemaTableDefinition,
	SchemaKvDefinition,
	WorkspaceSchema,
	// Data types
	CellValue,
	RowData,
	TypedCell,
	TypedRowWithCells,
	// Store interfaces
	TableStore,
	KvStore,
	// Workspace client
	CellWorkspaceClient,
	CreateCellWorkspaceOptions,
	// Events
	ChangeEvent,
	ChangeHandler,
} from './types';

// Key utilities
export {
	generateRowId,
	validateId,
	cellKey,
	parseCellKey,
	rowPrefix,
	hasPrefix,
} from './keys';

// KV store array name (for advanced use cases)
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

// Icon type and utilities from Core (for LWW-safe icons)
export type { Icon, IconType } from '../core/schema/fields/types';
export { parseIcon, createIcon, isIcon } from '../core/schema/fields/types';

// Core field factories for programmatic schema creation
export {
	table,
	setting,
	id,
	text,
	richtext,
	integer,
	real,
	boolean,
	date,
	select,
	tags,
	json,
} from '../core/schema/fields/factories';
