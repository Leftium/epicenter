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
export type { ExtensionError } from './core/errors';
// Error types
export { ExtensionErr } from './core/errors';
// Lifecycle protocol (shared by providers and extensions)
export type { Lifecycle, MaybePromise } from './core/lifecycle';
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
	// Id is exported as a value (function) below, which also provides the type
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
	Id,
	ISO_DATETIME_REGEX,
	id,
	integer,
	isIcon,
	isNullableField,
	json,
	normalizeIcon,
	parseIcon,
	real,
	select,
	TIMEZONE_ID_REGEX,
	table,
	tableToArktype,
	tableToYjsArktype,
	tags,
	text,
	toSqlIdentifier,
} from './core/schema';
// Core types
export type { AbsolutePath, ProjectDir } from './core/types';
export type { KvKey, TableKey as TableKeyType } from './core/ydoc-keys';
// Y.Doc storage keys (for direct Y.Doc access / custom providers)
export { KV_KEY, TableKey } from './core/ydoc-keys';
// Extension system (workspace-level plugins)
export type {
	ExtensionContext,
	ExtensionExports,
	ExtensionFactory,
	ExtensionFactoryMap,
	InferExtensionExports,
} from './dynamic/extension';
export { defineExports } from './dynamic/extension';
// Y.Doc wrappers for collaborative workspace architecture
export type { Kv, KvHelper } from './dynamic/kv/create-kv';
export { createKv } from './dynamic/kv/create-kv';
export type {
	InferProviderExports,
	ProviderContext,
	ProviderExports,
	ProviderFactory,
	ProviderFactoryMap,
} from './dynamic/provider-types';
export type { TableHelper, Tables } from './dynamic/tables/create-tables';
// Table utilities
export { createTables } from './dynamic/tables/create-tables';
export type {
	DeleteManyResult,
	DeleteResult,
	GetResult,
	InvalidRowResult,
	NotFoundResult,
	RowResult,
	UpdateManyResult,
	UpdateResult,
	ValidRowResult,
} from './dynamic/tables/table-helper';
// Workspace client types
export type {
	WorkspaceClient,
	WorkspaceClientBuilder,
} from './dynamic/workspace/types';
export type { WorkspaceDefinition } from './dynamic/workspace/workspace';
export {
	defineWorkspace,
	validateWorkspaceDefinition,
	WorkspaceDefinitionSchema,
	WorkspaceDefinitionValidator,
} from './dynamic/workspace/workspace';
export type {
	KvYArray,
	TablesYMap,
	TableYMap,
} from './dynamic/workspace-doc';

// Note: Workspace APIs are NOT re-exported from root to avoid naming conflicts.
// Import from sub-paths:
//   import { createTables } from '@epicenter/hq/dynamic';     // Row-level YKeyValueLww
//   import { createWorkspace } from '@epicenter/hq/static';   // Row-level with versioning
//
// Extensions are also NOT re-exported here to avoid bundling Node.js-only code
// in browser builds. Import them directly from subpaths:
//   import { persistence } from '@epicenter/hq/extensions/persistence';
//   import { sqlite } from '@epicenter/hq/extensions/sqlite';
