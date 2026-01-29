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
	// New field type names (preferred)
	BooleanField,
	DateField,
	IdField,
	IntegerField,
	JsonField,
	RealField,
	RichtextField,
	SelectField,
	TagsField,
	TextField,

	// Legacy type aliases (deprecated, kept for backwards compatibility)
	/** @deprecated Use `BooleanField` instead */
	BooleanFieldSchema,
	/** @deprecated Use `DateField` instead */
	DateFieldSchema,
	/** @deprecated Use `Field` instead. FieldSchema is now identical to Field. */
	FieldSchema,
	/** @deprecated Use `IdField` instead */
	IdFieldSchema,
	/** @deprecated Use `IntegerField` instead */
	IntegerFieldSchema,
	/** @deprecated Use `JsonField` instead */
	JsonFieldSchema,
	/** @deprecated Use `RealField` instead */
	RealFieldSchema,
	/** @deprecated Use `RichtextField` instead */
	RichtextFieldSchema,
	/** @deprecated Use `SelectField` instead */
	SelectFieldSchema,
	/** @deprecated Use `TagsField` instead */
	TagsFieldSchema,
	/** @deprecated Use `TextField` instead */
	TextFieldSchema,

	// Common types
	CellValue,
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
	PartialRow,
	Row,
	TableDefinition,

	// KV types
	KvField,
	KvValue,

	// Deprecated KV types (kept for backwards compatibility)
	/** @deprecated Use `KvField[]` array instead */
	KvDefinition,
	/** @deprecated Use `KvField[]` array instead */
	KvDefinitionMap,
	/** @deprecated Use `KvField[]` array instead */
	KvMap,

	// Deprecated table types (kept for backwards compatibility)
	/** @deprecated Use `TableDefinition[]` array instead */
	TableDefinitionMap,

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
export type {
	ClientBuilder,
	/** @deprecated Use `WorkspaceDefinitionV2` with arrays instead */
	WorkspaceDefinition,
	WorkspaceDefinitionV2,
} from './core/workspace/workspace';
export {
	/** @deprecated Use `createCellWorkspace` from `@epicenter/hq/cell` instead */
	createClient,
	/** @deprecated Use `defineWorkspaceV2` or `createCellWorkspace` instead */
	defineWorkspace,
	defineWorkspaceV2,
} from './core/workspace/workspace';

// ════════════════════════════════════════════════════════════════════════════
// Cell API (preferred for new projects)
// ════════════════════════════════════════════════════════════════════════════
//
// The Cell API is the recommended approach for new projects:
// - Cell-level LWW CRDT (better concurrent editing than row-level)
// - HeadDoc integration for epoch/time-travel support
// - Builder pattern with typed extensions
//
// Import from '@epicenter/hq/cell' for full Cell API, or use these re-exports.

export { createCellWorkspace } from './cell';
export type {
	CellExtensionContext,
	CellExtensionFactory,
	CellExtensionFactoryMap,
	CellWorkspaceBuilder,
	CellWorkspaceClient,
	CreateCellWorkspaceWithHeadDocOptions,
	InferCellExtensionExports,
	WorkspaceDefinition as CellWorkspaceDefinition,
	SchemaTableDefinition as CellTableDefinition,
	SchemaFieldDefinition as CellFieldDefinition,
} from './cell';

// Note: Extensions (markdown, sqlite) are NOT re-exported here to avoid bundling
// Node.js-only code in browser builds. Import them directly from subpaths:
//   import { markdown } from '@epicenter/hq/extensions/markdown';
//   import { sqlite } from '@epicenter/hq/extensions/sqlite';
