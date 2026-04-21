/**
 * Workspace API for Epicenter
 *
 * A composable, type-safe API for defining and creating workspaces
 * with versioned tables and KV stores.
 *
 * Tables use `_v: number` as a discriminant field for versioning and migration
 * (underscore signals framework metadata—see `BaseRow` for rationale).
 * KV stores use `defineKv(schema, defaultValue)` with validate-or-default semantics.
 *
 * @example
 * ```typescript
 * import { createWorkspace, defineTable, defineKv } from '@epicenter/workspace';
 * import { type } from 'arktype';
 *
 * // Tables: shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string', _v: '1' }));
 *
 * // Tables: variadic for multiple versions with migration
 * const posts = defineTable(
 *   type({ id: 'string', title: 'string', _v: '1' }),
 *   type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
 * ).migrate((row) => {
 *   switch (row._v) {
 *     case 1: return { ...row, views: 0, _v: 2 };
 *     case 2: return row;
 *   }
 * });
 *
 * // KV: schema + default value (no versioning)
 * const sidebar = defineKv(type('boolean'), false);
 * const fontSize = defineKv(type('number'), 14);
 *
 * // Create client (synchronous, directly usable)
 * const client = createWorkspace({
 *   id: 'my-app',
 *   tables: { users, posts },
 *   kv: { sidebar, fontSize },
 * });
 *
 * // Use tables and KV
 * client.tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
 * client.kv.set('fontSize', 16);
 *
 * // Or add extensions
 * const clientWithExt = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('sqlite', sqlite)
 *   .withExtension('persistence', persistence);
 *
 * // Cleanup
 * await client.dispose();
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
	ACTION_BRAND,
	defineMutation,
	defineQuery,
	dispatchAction,
	isAction,
	isMutation,
	isQuery,
	iterateActions,
} from '../shared/actions.js';
// Error types
export { ExtensionError } from '../shared/errors.js';
// Lifecycle protocol
export type {
	MaybePromise,
	RawExtension,
	SharedExtensionContext,
} from './lifecycle.js';

// ════════════════════════════════════════════════════════════════════════════
// Y.DOC STORAGE KEYS
// ════════════════════════════════════════════════════════════════════════════

export type { KvKey, TableKey as TableKeyType } from '@epicenter/document';
// Y.Doc array key conventions (for direct Y.Doc access / custom providers)
export { KV_KEY, TableKey } from '@epicenter/document';

// ════════════════════════════════════════════════════════════════════════════
// Schema Definitions (Pure)
// ════════════════════════════════════════════════════════════════════════════

export { defineKv } from './define-kv.js';
export { defineTable } from './define-table.js';
export type { EncryptionAttachment } from '../shared/attach-encryption.js';

// ════════════════════════════════════════════════════════════════════════════
// Workspace Creation
// ════════════════════════════════════════════════════════════════════════════

export { createWorkspace } from './create-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Introspection
// ════════════════════════════════════════════════════════════════════════════

export type {
	ActionDescriptor,
	SchemaDescriptor,
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
	Awareness,
	AwarenessDefinitions,
	AwarenessState,
	BaseRow,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	Kv,
	KvChange,
	KvDefinition,
	KvDefinitions,
	NotFoundResult,
	RowResult,
	Table,
	TableDefinition,
	TableDefinitions,
	Tables,
	UpdateResult,
	ValidRowResult,
} from '@epicenter/document';
export type { JsonObject, JsonValue } from 'wellcrafted/json';
export type {
	AnyWorkspaceClient,
	ExtensionContext,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceDefinition,
} from './create-workspace.js';
