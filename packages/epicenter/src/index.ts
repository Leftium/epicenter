/**
 * Epicenter: YJS-First Collaborative Workspace System
 *
 * A unified architecture for building self-contained, globally synchronizable workspaces
 * with real-time collaboration via YJS.
 *
 * ## Core Concepts
 *
 * - **YJS Document**: Source of truth (CRDT, collaborative)
 * - **Extensions**: Plugins that add persistence, sync, and materialized views
 * - **Column Schemas**: Pure JSON definitions (no Drizzle builders)
 *
 * ## Data Flow
 *
 * Write to YJS → Extensions auto-sync → Query materialized views
 */

// Re-export commonly used Drizzle utilities for querying extensions
export {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	lte,
	ne,
	not,
	or,
	sql,
} from 'drizzle-orm';
// Action system
export type { Action, Actions, Mutation, Query } from './core/actions';
export {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
} from './core/actions';
// Y.Doc wrappers for collaborative workspace architecture
export type {
	DefinitionMap,
	HeadDoc,
	InferProviderExports,
	KvYMap,
	ProviderContext,
	ProviderExports,
	ProviderFactory,
	ProviderFactoryMap,
	WorkspaceDefinitionMap,
	WorkspaceDoc,
	WorkspaceMeta,
} from './core/docs';
export {
	createHeadDoc,
	createWorkspaceDoc,
	WORKSPACE_DOC_MAPS,
} from './core/docs';

export type { ExtensionError } from './core/errors';
// Error types
export { ExtensionErr } from './core/errors';
// Extension system (workspace-level plugins)
export type {
	ExtensionContext,
	ExtensionExports,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
} from './core/extension';
export { defineExports } from './core/extension';
export type { Kv, KvHelper } from './core/kv/core';
export { createKv } from './core/kv/core';
// Lifecycle protocol (shared by providers and extensions)
export type { Lifecycle, MaybePromise } from './core/lifecycle';
export { LifecycleExports } from './core/lifecycle';
// Rich content ID generation
export type { RichContentId } from './core/rich-content/id';
export { createRichContentId } from './core/rich-content/id';
export type {
	// Field types
	BooleanField,
	CellValue,
	DateField,
	Field,
	FieldById,
	FieldIds,
	FieldMetadata,
	FieldOptions,
	FieldType,
	Guid,
	Icon,
	IconType,
	Id,
	IdField,
	IntegerField,
	JsonField,
	// KV types
	KvField,
	KvFieldById,
	KvFieldIds,
	KvValue,
	PartialRow,
	RealField,
	RichtextField,
	Row,
	SelectField,
	TableById,
	TableDefinition,
	TableIds,
	TagsField,
	TextField,
	// Date types
	TimezoneId,
} from './core/schema';
// Column schema system
export {
	boolean,
	createIcon,
	DATE_TIME_STRING_REGEX,
	DateTimeString,
	date,
	generateGuid,
	generateId,
	ISO_DATETIME_REGEX,
	id,
	integer,
	isIcon,
	isNullableField,
	json,
	parseIcon,
	real,
	richtext,
	select,
	TIMEZONE_ID_REGEX,
	table,
	tableToArktype,
	tableToYjsArktype,
	tags,
	text,
	toSqlIdentifier,
} from './core/schema';
export type { TableHelper, Tables } from './core/tables/create-tables';
// Table utilities
export { createTables } from './core/tables/create-tables';
export type {
	DeleteManyResult,
	DeleteResult,
	GetResult,
	InvalidRowResult,
	NotFoundResult,
	RowAction,
	RowChanges,
	RowResult,
	UpdateManyResult,
	UpdateResult,
	ValidRowResult,
} from './core/tables/table-helper';
// Core types
export type { AbsolutePath, ProjectDir } from './core/types';
// Workspace normalization helpers
export {
	DEFAULT_KV_ICON,
	isKvDefinition,
	isTableDefinition,
	normalizeIcon,
} from './core/workspace/normalize';
export type { WorkspaceDefinition } from './core/workspace/workspace';
export { defineWorkspace } from './core/workspace/workspace';

// Note: Workspace APIs are NOT re-exported from root to avoid naming conflicts.
// Import from sub-paths:
//   import { createWorkspace } from '@epicenter/hq/dynamic';  // Cell-level CRDT
//   import { createWorkspace } from '@epicenter/hq/static';   // Row-level CRDT
//
// Extensions are also NOT re-exported here to avoid bundling Node.js-only code
// in browser builds. Import them directly from subpaths:
//   import { persistence } from '@epicenter/hq/extensions/persistence';
//   import { sqlite } from '@epicenter/hq/extensions/sqlite';
