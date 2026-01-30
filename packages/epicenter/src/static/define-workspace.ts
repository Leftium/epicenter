/**
 * defineWorkspace() - High-level API for creating workspaces with tables, KV, and capabilities.
 *
 * @example
 * ```typescript
 * import { defineWorkspace, defineTable, defineKv } from 'epicenter/static';
 * import { type } from 'arktype';
 *
 * const posts = defineTable()
 *   .version(type({ id: 'string', title: 'string' }))
 *   .migrate((row) => row);
 *
 * const theme = defineKv()
 *   .version(type({ mode: "'light' | 'dark'" }))
 *   .migrate((v) => v);
 *
 * const workspace = defineWorkspace({
 *   id: 'my-app',
 *   tables: { posts },
 *   kv: { theme },
 * });
 *
 * // Synchronous creation
 * const client = workspace.create();
 *
 * // With capabilities
 * const client = workspace.create({ sqlite, persistence });
 * await client.capabilities.persistence.whenSynced;
 * ```
 */

import * as Y from 'yjs';
import type { Lifecycle } from '../core/lifecycle.js';
import { createKv } from './create-kv.js';
import { createTables } from './create-tables.js';
import type {
	CapabilityFactory,
	CapabilityMap,
	InferCapabilityExports,
	KvDefinitions,
	TableDefinitions,
	WorkspaceClient,
	WorkspaceDefinition,
} from './types.js';

/**
 * Defines a workspace with tables, KV stores, and optional capabilities.
 *
 * The returned workspace definition can be used to create workspace clients
 * with `.create()`.
 *
 * @param config - Workspace configuration
 * @param config.id - Workspace identifier (used as Y.Doc guid)
 * @param config.tables - Optional map of table definitions
 * @param config.kv - Optional map of KV definitions
 * @returns WorkspaceDefinition with `.create()` method
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

		create<TCapabilities extends CapabilityMap = Record<string, never>>(
			capabilities?: TCapabilities,
		): WorkspaceClient<TId, TTableDefinitions, TKvDefinitions, TCapabilities> {
			// Create Y.Doc with workspace ID as GUID
			const ydoc = new Y.Doc({
				guid: id,
			});

			// Create tables and KV helpers
			const tables = createTables(ydoc, tableDefinitions);
			const kv = createKv(ydoc, kvDefinitions);

			// Initialize capabilities (each returns Lifecycle via defineExports)
			const capabilityExports = Object.fromEntries(
				Object.entries(capabilities ?? {}).map(([name, factory]) => [
					name,
					(factory as CapabilityFactory<TTableDefinitions, TKvDefinitions>)({
						ydoc,
						workspaceId: id,
						tables,
						kv,
					}),
				]),
			) as Record<string, Lifecycle>;

			// Destroy function - capabilities guarantee destroy() exists via Lifecycle
			async function destroy(): Promise<void> {
				await Promise.all(
					Object.values(capabilityExports).map((c) => c.destroy()),
				);
				ydoc.destroy();
			}

			return {
				id,
				ydoc,
				tables,
				kv,
				capabilities:
					capabilityExports as InferCapabilityExports<TCapabilities>,
				destroy,
				[Symbol.asyncDispose]: destroy,
			};
		},
	};
}

// Re-export types for convenience
export type {
	CapabilityFactory,
	CapabilityMap,
	WorkspaceClient,
	WorkspaceDefinition,
};
