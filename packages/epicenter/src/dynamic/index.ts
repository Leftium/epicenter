/**
 * Dynamic Workspace - Row-Level YKeyValueLww API
 *
 * A unified workspace implementation with:
 * - Row-level LWW (Last-Write-Wins) CRDT storage via YKeyValueLww
 * - External schema with validation (definition passed in)
 * - Optional HeadDoc for time travel and epochs
 *
 * Y.Doc structure:
 * ```
 * Y.Doc
 * +-- Y.Array('table:posts')  <- Table data (rows as LWW entries)
 * +-- Y.Array('table:users')  <- Another table
 * +-- Y.Array('kv')           <- Workspace-level key-values
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE API (builder pattern)
// ════════════════════════════════════════════════════════════════════════════

export type { WorkspaceDefinition } from '../core/schema/workspace-definition';
// HeadDoc (for time travel and epochs)
export { createHeadDoc, type HeadDoc } from './docs/head-doc';
// The new builder pattern API
export { createWorkspace } from './workspace/create-workspace';
export type {
	CreateWorkspaceConfig,
	ExtensionContext,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
	WorkspaceClient,
	WorkspaceClientBuilder,
} from './workspace/types';
// Workspace definition helpers
export { defineWorkspace } from './workspace/workspace';

// ════════════════════════════════════════════════════════════════════════════
// LIFECYCLE & CORE UTILITIES
// ════════════════════════════════════════════════════════════════════════════

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
	select,
	table,
	tags,
	text,
} from '../core/schema/fields/factories';

// Icon type and utilities from Core
export type { Icon, IconType } from '../core/schema/fields/types';
export { createIcon, isIcon, parseIcon } from '../core/schema/fields/types';

// ════════════════════════════════════════════════════════════════════════════
// TABLES & KV
// ════════════════════════════════════════════════════════════════════════════

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

// KV store (YKeyValueLww-based)
export { createKvHelper, type KvHelper } from './kv/kv-helper';

// Tables API (YKeyValueLww-based row-level storage)
export {
	createTables,
	type GetResult,
	type InvalidRowResult,
	type RowResult,
	type TableHelper,
	type Tables,
	type TablesFunction,
	type UntypedTableHelper,
	type ValidRowResult,
} from './tables/create-tables';

export {
	type ChangedRowIds,
	createTableHelper,
	createTableHelpers,
	createUntypedTableHelper,
	type DeleteManyResult,
	type DeleteResult,
	type NotFoundResult,
	type UpdateManyResult,
	type UpdateResult,
	type ValidationError,
} from './tables/table-helper';
