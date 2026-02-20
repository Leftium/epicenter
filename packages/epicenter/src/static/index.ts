/**
 * Static Workspace API for Epicenter
 *
 * A composable, type-safe API for defining and creating workspaces
 * with versioned tables and KV stores.
 *
 * All table and KV schemas must include `_v: number` as a discriminant field.
 * Use shorthand for single versions, builder pattern for multiple versions with migrations.
 *
 * @example
 * ```typescript
 * import { createWorkspace, defineTable, defineKv } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Tables: shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 *
 * // Tables: builder pattern for multiple versions with migration
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string', _v: '1' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '2' }))
 *   .migrate((row) => {
 *     switch (row._v) {
 *       case 1: return { ...row, views: 0, _v: 2 };
 *       case 2: return row;
 *     }
 *   });
 *
 * // KV: shorthand for single version
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number', _v: '1' }));
 *
 * // KV: builder pattern for multiple versions with migration
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'", _v: '1' }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '2' }))
 *   .migrate((v) => {
 *     switch (v._v) {
 *       case 1: return { ...v, fontSize: 14, _v: 2 };
 *       case 2: return v;
 *     }
 *   });
 *
 * // Create client (synchronous, directly usable)
 * const client = createWorkspace({
 *   id: 'my-app',
 *   tables: { users, posts },
 *   kv: { sidebar, theme },
 * });
 *
 * // Use tables and KV
 * client.tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
 * client.kv.set('theme', { mode: 'system', fontSize: 16, _v: 2 });
 *
 * // Or add extensions
 * const clientWithExt = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('sqlite', sqlite)
 *   .withExtension('persistence', persistence);
 *
 * // Cleanup
 * await client.destroy();
 * ```
 *
 * @packageDocumentation
 */

// ════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES (also exported from root for convenience)
// ════════════════════════════════════════════════════════════════════════════

// Action system
export type { Action, Actions, Mutation, Query } from '../shared/actions.js';
export {
	defineMutation,
	defineQuery,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
} from '../shared/actions.js';
// Error types
export type { ExtensionError } from '../shared/errors.js';
export { ExtensionErr } from '../shared/errors.js';
// Lifecycle protocol
export type {
	DocumentContext,
	DocumentLifecycle,
	Extension,
	Lifecycle,
	MaybePromise,
} from '../shared/lifecycle.js';

// ════════════════════════════════════════════════════════════════════════════
// Y.DOC STORAGE KEYS
// ════════════════════════════════════════════════════════════════════════════

export type { KvKey, TableKey as TableKeyType } from '../shared/ydoc-keys.js';
// Y.Doc array key conventions (for direct Y.Doc access / custom providers)
export { KV_KEY, TableKey } from '../shared/ydoc-keys.js';

// ════════════════════════════════════════════════════════════════════════════
// Schema Definitions (Pure)
// ════════════════════════════════════════════════════════════════════════════

export { defineKv } from './define-kv.js';
export { defineTable } from './define-table.js';
export { defineWorkspace } from './define-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Workspace Creation
// ════════════════════════════════════════════════════════════════════════════

export type { CreateDocumentBindingConfig } from './create-document-binding.js';
export {
	createDocumentBinding,
	DOCUMENT_BINDING_ORIGIN,
} from './create-document-binding.js';
export { createWorkspace } from './create-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Lower-Level APIs (Bring Your Own Y.Doc)
// ════════════════════════════════════════════════════════════════════════════

export { createAwareness } from './create-awareness.js';
export { createKv } from './create-kv.js';
export { createTables } from './create-tables.js';

// ════════════════════════════════════════════════════════════════════════════
// Introspection
// ════════════════════════════════════════════════════════════════════════════

export type {
	ActionDescriptor,
	AwarenessDescriptor,
	KvDescriptor,
	TableDescriptor,
	WorkspaceDescriptor,
} from './describe-workspace.js';
export { describeWorkspace } from './describe-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Validation Utilities
// ════════════════════════════════════════════════════════════════════════════

export { createUnionSchema } from './schema-union.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type {
	// Any-typed client (for duck-typing in CLI/server)
	AnyWorkspaceClient,
	// Awareness types
	AwarenessDefinitions,
	AwarenessHelper,
	AwarenessState,
	// Base row type
	BaseRow,
	DeleteResult,
	// Document binding types
	DocBinding,
	DocsPropertyOf,
	DocumentBinding,
	// Extension types
	ExtensionContext,
	ExtensionFactory,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	KvChange,
	KvDefinition,
	KvDefinitions,
	KvGetResult,
	KvHelper,
	NotFoundResult,
	NumberKeysOf,
	// Result types - composed
	RowResult,
	StringKeysOf,
	// Definition types
	TableDefinition,
	// Map types
	TableDefinitions,
	// Helper types
	TableHelper,
	TablesHelper,
	UpdateResult,
	// Result types - building blocks
	ValidRowResult,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceClientWithActions,
	// Workspace types
	WorkspaceDefinition,
} from './types.js';
