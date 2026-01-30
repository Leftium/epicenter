/**
 * defineWorkspace() - Pure definition of a workspace schema.
 *
 * This creates a reusable definition that can be passed to createWorkspace().
 * Optional for composability; you can also pass the config directly to createWorkspace().
 *
 * @example
 * ```typescript
 * import { defineWorkspace, createWorkspace, defineTable, defineKv } from 'epicenter/static';
 *
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string' }))
 *   .migrate((row) => row);
 *
 * // Option 1: Reusable definition
 * const workspace = defineWorkspace({ id: 'my-app', tables: { posts } });
 * const client = createWorkspace(workspace);
 *
 * // Option 2: Direct (skip defineWorkspace)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
 * ```
 */

import type {
	KvDefinitions,
	TableDefinitions,
	WorkspaceDefinition,
} from './types.js';

/**
 * Defines a workspace with tables and KV stores.
 *
 * Returns a pure definition object. Use createWorkspace() to instantiate.
 *
 * @param config - Workspace configuration
 * @param config.id - Workspace identifier (used as Y.Doc guid)
 * @param config.tables - Optional map of table definitions
 * @param config.kv - Optional map of KV definitions
 * @returns WorkspaceDefinition (pass to createWorkspace)
 */
export function defineWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
>({
	id,
	tables: tableDefinitions = {} as TTableDefinitions,
	kv: kvDefinitions = {} as TKvDefinitions,
}: {
	id: TId;
	tables?: TTableDefinitions;
	kv?: TKvDefinitions;
}): WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions> {
	return {
		id,
		tableDefinitions,
		kvDefinitions,
	};
}

// Re-export types for convenience
export type { WorkspaceDefinition };
