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

import type { Field, TableDefinition } from '../core/schema/fields/types';

// HeadDoc (re-exported from core for convenience)
export { createHeadDoc, type HeadDoc } from '../core/docs/head-doc';

// Lifecycle utilities (re-exported for extension authors)
export {
	defineExports,
	type Lifecycle,
	type MaybePromise,
} from '../core/lifecycle';

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
	table,
	tags,
	text,
} from '../core/schema/fields/factories';
// Icon type and utilities from Core (for LWW-safe icons)
// Schema types (re-exported from core for backwards compatibility)
export type {
	Field,
	Field as SchemaFieldDefinition,
	FieldType,
	Icon,
	IconType,
	KvField as SchemaKvDefinition,
	TableDefinition,
} from '../core/schema/fields/types';
export { createIcon, isIcon, parseIcon } from '../core/schema/fields/types';
export type { WorkspaceDefinition } from '../core/workspace/workspace';
/**
 * Alias for TableDefinition for backwards compatibility.
 * Consumers may use SchemaTableDefinition in their code.
 */
export type SchemaTableDefinition = TableDefinition<readonly Field[]>;
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
	CellKey,
	generateRowId,
	hasPrefix,
	parseCellKey,
	RowPrefix,
	validateId,
} from './keys';
// Schema file utilities
export { getTableById, parseSchema } from './schema-file';
// KV store array name (for advanced use cases)
export { KV_ARRAY_NAME } from './stores/kv-store';
// Table helper factory (for advanced use)
export { createTableHelper } from './table-helper';
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
	// Store interfaces
	KvStore,
	RowData,
	TableHelper,
	TypedCell,
	TypedRowWithCells,
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
