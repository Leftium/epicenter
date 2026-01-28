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

// HeadDoc (re-exported from core for convenience)
export { createHeadDoc, type HeadDoc } from '../core/docs/head-doc';

// Lifecycle utilities (re-exported for extension authors)
export { defineExports, type Lifecycle, type MaybePromise } from '../core/lifecycle';

// Core field factories for programmatic schema creation
export {
	boolean,
	date,
	id,
	integer,
	json,
	real,
	richtext,
	select,
	setting,
	table,
	tags,
	text,
} from '../core/schema/fields/factories';
// Icon type and utilities from Core (for LWW-safe icons)
export type { Icon, IconType } from '../core/schema/fields/types';
export { createIcon, isIcon, parseIcon } from '../core/schema/fields/types';
// TypeBox converters for cell schemas
export {
	schemaFieldToTypebox,
	schemaTableToTypebox,
} from './converters/to-typebox';
// Factory
export { createCellWorkspace } from './create-cell-workspace';
// Extension types
export type {
	CellExtensionContext,
	CellExtensionFactory,
	CellExtensionFactoryMap,
	CellWorkspaceBuilder,
	InferCellExtensionExports,
} from './extensions';

// Key utilities
export {
	cellKey,
	generateRowId,
	hasPrefix,
	parseCellKey,
	rowPrefix,
	validateId,
} from './keys';
// Schema file utilities
export {
	addField,
	addTable,
	createEmptySchema,
	getNextFieldOrder,
	getSortedFields,
	parseSchema,
	removeField,
	removeTable,
	stringifySchema,
} from './schema-file';
// KV store array name (for advanced use cases)
export { KV_ARRAY_NAME } from './stores/kv-store';
// Table store factory (for advanced use)
export { createTableStore } from './table-store';
// Types
export type {
	// Data types
	CellValue,
	// Workspace client
	CellWorkspaceClient,
	// Events
	ChangeEvent,
	ChangeHandler,
	CreateCellWorkspaceOptions,
	// HeadDoc-based options (new API)
	CreateCellWorkspaceWithHeadDocOptions,
	// Schema types (external JSON)
	FieldType,
	KvStore,
	RawTableAccess,
	RowData,
	SchemaFieldDefinition,
	SchemaKvDefinition,
	SchemaTableDefinition,
	// Store interfaces
	TableStore,
	TypedCell,
	TypedRowWithCells,
	WorkspaceSchema,
} from './types';
// Validation result types
export type {
	CellResult,
	GetCellResult,
	GetResult,
	InvalidCellResult,
	InvalidRowResult,
	NotFoundCellResult,
	NotFoundResult,
	RowResult,
	// Re-exported from core (row-level)
	ValidationError,
	// Cell-level results
	ValidCellResult,
	ValidRowResult,
} from './validation-types';
