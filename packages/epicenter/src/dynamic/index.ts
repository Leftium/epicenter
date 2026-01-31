/**
 * Dynamic Workspace - Cell-Level CRDT API
 *
 * A unified workspace implementation with:
 * - Cell-level CRDT storage (one Y.Array per table)
 * - External schema with validation (definition passed in)
 * - Optional HeadDoc for time travel and epochs
 * - Builder pattern for type-safe extension setup
 *
 * Y.Doc structure:
 * ```
 * Y.Doc
 * +-- Y.Array('table:posts')  <- Table data (cells)
 * +-- Y.Array('table:users')  <- Another table
 * +-- Y.Array('kv')           <- Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

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
// Icon type and utilities from Core
export type { Icon, IconType } from '../core/schema/fields/types';
export { createIcon, isIcon, parseIcon } from '../core/schema/fields/types';
// Factory
export { createWorkspace, createWorkspaceYDoc } from './create-workspace';
// HeadDoc (now local to dynamic)
export { createHeadDoc, type HeadDoc } from './docs/head-doc';

// Extension types
export type {
	ExtensionContext,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
	WorkspaceBuilder,
} from './extensions';
// Key utilities
export {
	CellKey,
	FieldId,
	generateRowId,
	hasPrefix,
	type ParsedCellKey,
	parseCellKey,
	RowId,
	RowPrefix,
	validateId,
} from './keys';
// KV store
export {
	createKvStore,
	KV_ARRAY_NAME,
	TABLE_ARRAY_PREFIX,
} from './stores/kv-store';
// Table helper factory (for advanced use)
export { createTableHelper } from './table-helper';

// Types
export type {
	// Data types
	CellValue,
	ChangeEvent,
	ChangeHandler,
	CreateWorkspaceOptions,
	FieldDefinition,
	FieldType,
	GetCellResult,
	GetResult,
	HeadDocInterface,
	InvalidCellResult,
	InvalidKvResult,
	InvalidRowResult,
	KvDefinition,
	KvGetResult,
	KvResult,
	KvStore,
	NotFoundCellResult,
	NotFoundKvResult,
	NotFoundRowResult,
	RowData,
	RowResult,
	TableDef,
	TableHelper,
	TypedCell,
	TypedRowWithCells,
	ValidationError,
	ValidCellResult,
	ValidKvResult,
	ValidRowResult,
	WorkspaceClient,
	WorkspaceDef,
} from './types';
