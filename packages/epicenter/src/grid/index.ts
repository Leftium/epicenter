/**
 * Grid Workspace - Unified Cell-Level CRDT API
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
 * +-- Y.Array('posts')    <- Table data (cells)
 * +-- Y.Array('users')    <- Another table
 * +-- Y.Array('kv')       <- Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

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

// Icon type and utilities from Core
export type { Icon, IconType } from '../core/schema/fields/types';
export { createIcon, isIcon, parseIcon } from '../core/schema/fields/types';

// Factory
export {
	createGridWorkspace,
	createWorkspaceYDoc,
} from './create-grid-workspace';

// Extension types
export type {
	GridExtensionContext,
	GridExtensionFactory,
	GridExtensionFactoryMap,
	GridWorkspaceBuilder,
	InferGridExtensionExports,
} from './extensions';

// Table helper factory (for advanced use)
export { createGridTableHelper } from './grid-table-helper';

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
export { createGridKvStore, KV_ARRAY_NAME } from './stores/kv-store';

// Types
export type {
	// Data types
	CellValue,
	ChangeEvent,
	ChangeHandler,
	CreateGridWorkspaceOptions,
	FieldType,
	GetCellResult,
	GetResult,
	GridFieldDefinition,
	GridHeadDoc,
	GridKvDefinition,
	GridKvStore,
	GridTableDefinition,
	GridTableHelper,
	GridWorkspaceClient,
	GridWorkspaceDefinition,
	InvalidCellResult,
	InvalidRowResult,
	NotFoundCellResult,
	NotFoundRowResult,
	RowData,
	RowResult,
	TypedCell,
	TypedRowWithCells,
	ValidationError,
	ValidCellResult,
	ValidRowResult,
} from './types';
