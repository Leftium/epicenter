/**
 * Static Workspace API for Epicenter
 *
 * A composable, type-safe API for defining and creating workspaces
 * with versioned tables and KV stores.
 *
 * @example
 * ```typescript
 * import { createWorkspace, defineTable, defineKv } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * // Tables: shorthand for single version
 * const users = defineTable(type({ id: 'string', email: 'string' }));
 *
 * // Tables: builder pattern for multiple versions with migration
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string', _v: '"1"' }))
 *   .version(type({ id: 'string', title: 'string', views: 'number', _v: '"2"' }))
 *   .migrate((row) => {
 *     if (row._v === '1') return { ...row, views: 0, _v: '2' as const };
 *     return row;
 *   });
 *
 * // KV: shorthand for single version
 * const sidebar = defineKv(type({ collapsed: 'boolean', width: 'number' }));
 *
 * // KV: builder pattern for multiple versions with migration (use _v discriminant)
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'", _v: '"1"' }))
 *   .version(type({ mode: "'light' | 'dark' | 'system'", fontSize: 'number', _v: '"2"' }))
 *   .migrate((v) => {
 *     if (v._v === '1') return { ...v, fontSize: 14, _v: '2' as const };
 *     return v;
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
 * client.tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: '2' });
 * client.kv.set('theme', { mode: 'system', fontSize: 16, _v: '2' });
 *
 * // Or add extensions
 * const clientWithExt = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtensions({ sqlite, persistence });
 *
 * // Cleanup
 * await client.destroy();
 * ```
 *
 * @packageDocumentation
 */

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

export { createWorkspace } from './create-workspace.js';

// ════════════════════════════════════════════════════════════════════════════
// Lower-Level APIs (Bring Your Own Y.Doc)
// ════════════════════════════════════════════════════════════════════════════

export { createKv } from './create-kv.js';
export { createTables } from './create-tables.js';

// ════════════════════════════════════════════════════════════════════════════
// Validation Utilities
// ════════════════════════════════════════════════════════════════════════════

export { createUnionSchema } from './schema-union.js';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type {
	// Capability types
	CapabilityContext,
	CapabilityFactory,
	CapabilityMap,
	DeleteResult,
	GetResult,
	InferCapabilityExports,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	KvBatchTransaction,
	KvChange,
	KvDefinition,
	KvDefinitions,
	KvGetResult,
	KvHelper,
	NotFoundResult,
	// Result types - composed
	RowResult,
	TableBatchTransaction,
	// Definition types
	TableDefinition,
	// Map types
	TableDefinitions,
	// Helper types
	TableHelper,
	TablesHelper,
	// Result types - building blocks
	ValidRowResult,
	WorkspaceClient,
	WorkspaceClientBuilder,
	// Workspace types
	WorkspaceDefinition,
} from './types.js';
