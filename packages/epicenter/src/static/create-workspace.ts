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
	WorkspaceClientBuilder,
	WorkspaceDefinition,
} from './types.js';

/** Config for createWorkspace when passing raw config (not a definition) */
type CreateWorkspaceConfig<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
> = {
	id: TId;
	tables?: TTableDefinitions;
	kv?: TKvDefinitions;
};

/** Check if input is a WorkspaceDefinition (has tableDefinitions) or raw config (has tables) */
function isWorkspaceDefinition<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
>(
	input:
		| WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions>
		| CreateWorkspaceConfig<TId, TTableDefinitions, TKvDefinitions>,
): input is WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions> {
	return 'tableDefinitions' in input;
}

/**
 * Create a workspace client.
 *
 * The returned client IS directly usable (no extensions) AND has `.withExtensions()`
 * for adding extensions like persistence or SQLite.
 *
 * @param input - Either a WorkspaceDefinition from defineWorkspace() or raw config
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtensions()
 */
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
>(
	input:
		| WorkspaceDefinition<TId, TTableDefinitions, TKvDefinitions>
		| CreateWorkspaceConfig<TId, TTableDefinitions, TKvDefinitions>,
): WorkspaceClientBuilder<TId, TTableDefinitions, TKvDefinitions> {
	const id = input.id;
	const tableDefinitions = isWorkspaceDefinition(input)
		? input.tableDefinitions
		: ((input.tables ?? {}) as TTableDefinitions);
	const kvDefinitions = isWorkspaceDefinition(input)
		? input.kvDefinitions
		: ((input.kv ?? {}) as TKvDefinitions);

	const ydoc = new Y.Doc({ guid: id });
	const tables = createTables(ydoc, tableDefinitions);
	const kv = createKv(ydoc, kvDefinitions);

	async function destroy(): Promise<void> {
		ydoc.destroy();
	}

	const baseClient: WorkspaceClient<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		Record<string, never>
	> = {
		id,
		ydoc,
		tables,
		kv,
		capabilities: {} as InferCapabilityExports<Record<string, never>>,
		destroy,
		[Symbol.asyncDispose]: destroy,
	};

	function withExtensions<TCapabilities extends CapabilityMap>(
		capabilities: TCapabilities,
	): WorkspaceClient<TId, TTableDefinitions, TKvDefinitions, TCapabilities> {
		const capabilityExports = Object.fromEntries(
			Object.entries(capabilities).map(([name, factory]) => [
				name,
				(factory as CapabilityFactory<TTableDefinitions, TKvDefinitions>)({
					ydoc,
					workspaceId: id,
					tables,
					kv,
				}),
			]),
		) as Record<string, Lifecycle>;

		async function destroyWithCapabilities(): Promise<void> {
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
			capabilities: capabilityExports as InferCapabilityExports<TCapabilities>,
			destroy: destroyWithCapabilities,
			[Symbol.asyncDispose]: destroyWithCapabilities,
		};
	}

	return Object.assign(baseClient, { withExtensions });
}

export type { WorkspaceClient, WorkspaceClientBuilder };
