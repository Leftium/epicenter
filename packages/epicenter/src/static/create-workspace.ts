/**
 * createWorkspace() - Instantiate a workspace client.
 *
 * Returns a client that IS usable directly AND has `.withExtensions()`.
 *
 * @example
 * ```typescript
 * // Direct use (no extensions)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
 * client.tables.posts.set({ id: '1', title: 'Hello' });
 *
 * // With extensions
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtensions({ sqlite, persistence });
 *
 * // From reusable definition
 * const def = defineWorkspace({ id: 'my-app', tables: { posts } });
 * const client = createWorkspace(def);
 * ```
 */

import * as Y from 'yjs';
import type { Lifecycle } from '../shared/lifecycle.js';
import { createKv } from './create-kv.js';
import { createTables } from './create-tables.js';
import type {
	CapabilityFactory,
	CapabilityMap,
	InferCapabilityExports,
	KvDefinitions,
	TableDefinitions,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceDefinition,
} from './types.js';

/**
 * Create a workspace client.
 *
 * The returned client IS directly usable (no extensions) AND has `.withExtensions()`
 * for adding extensions like persistence or SQLite.
 *
 * @param config - Workspace config (or WorkspaceDefinition from defineWorkspace())
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtensions()
 */
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
>(
	config: WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions>,
): WorkspaceClientBuilder<TId, TTableDefinitions, TKvDefinitions> {
	const { id } = config;
	const ydoc = new Y.Doc({ guid: id });
	const tables = createTables(ydoc, (config.tables ?? {}) as TTableDefinitions);
	const kv = createKv(ydoc, (config.kv ?? {}) as TKvDefinitions);

	const destroy = async (): Promise<void> => {
		ydoc.destroy();
	};

	const baseClient = {
		id,
		ydoc,
		tables,
		kv,
		capabilities: {} as InferCapabilityExports<Record<string, never>>,
		destroy,
		[Symbol.asyncDispose]: destroy,
	};

	return {
		...baseClient,

		/**
		 * Attach capabilities (persistence, SQLite, sync, etc.) to the workspace.
		 *
		 * Each capability factory receives { ydoc, id, tables, kv } and
		 * returns a Lifecycle object with exports. The returned client includes
		 * all capability exports under `.capabilities`.
		 */
		withExtensions<TCapabilities extends CapabilityMap>(
			capabilities: TCapabilities,
		) {
			// Initialize each capability factory and collect their exports
			const capabilityExports = Object.fromEntries(
				Object.entries(capabilities).map(([name, factory]) => [
					name,
					(factory as CapabilityFactory<TTableDefinitions, TKvDefinitions>)({
						ydoc,
						id,
						tables,
						kv,
					}),
				]),
			) as Record<string, Lifecycle>;

			// Cleanup must destroy capabilities first, then the Y.Doc
			const destroyWithCapabilities = async (): Promise<void> => {
				await Promise.all(
					Object.values(capabilityExports).map((c) => c.destroy()),
				);
				ydoc.destroy();
			};

			const clientWithCapabilities = {
				id,
				ydoc,
				tables,
				kv,
				capabilities:
					capabilityExports as InferCapabilityExports<TCapabilities>,
				destroy: destroyWithCapabilities,
				[Symbol.asyncDispose]: destroyWithCapabilities,
			};

			return clientWithCapabilities;
		},
	};
}

export type { WorkspaceClient, WorkspaceClientBuilder };
