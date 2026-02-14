/**
 * createWorkspace() - Instantiate a dynamic workspace client.
 *
 * Returns a client that IS usable directly AND has `.withExtension()` for chaining.
 *
 * ## Extension chaining vs action maps
 *
 * Extensions use chainable `.withExtension(key, factory)` because they build on each
 * other progressively — each factory receives previously added extensions as typed context.
 * You may be importing extensions you don't control and want to compose on top of them.
 *
 * @example
 * ```typescript
 * // Direct use (no extensions)
 * const workspace = createWorkspace(definition);
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 *
 * // With extensions (chained)
 * const workspace = createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', ySweetSync({ auth: directAuth('...') }));
 *
 * 	await workspace.whenReady;
 * workspace.extensions.persistence.clearData();
 * ```
 */

import * as Y from 'yjs';
import type { Extension, MaybePromise } from '../../shared/lifecycle';
import { createKv } from '../kv/create-kv';
import type { KvField, TableDefinition } from '../schema/fields/types';
import type { WorkspaceDefinition } from '../schema/workspace-definition';
import { createTables } from '../tables/create-tables';
import type {
	ExtensionContext,
	WorkspaceClient,
	WorkspaceClientBuilder,
} from './types';

/**
 * Create a workspace client with chainable extension support.
 *
 * The returned client IS directly usable (no extensions required) AND supports
 * chaining `.withExtension()` calls to progressively add extensions, each with
 * typed access to all previously added extensions.
 *
 * ## Y.Doc Structure
 *
 * ```
 * Y.Doc (guid = definition.id, gc: true)
 * +-- Y.Array('table:posts')  <- Table data (LWW entries)
 * +-- Y.Array('table:users')  <- Another table
 * +-- Y.Array('kv')           <- KV settings (LWW entries)
 * ```
 *
 * @example Direct use (no extensions)
 * ```typescript
 * const workspace = createWorkspace(definition);
 * workspace.tables.get('posts').upsert({ id: '1', title: 'Hello' });
 * ```
 *
 * @example With extensions (chained)
 * ```typescript
 * const workspace = createWorkspace(definition)
 *   .withExtension('persistence', ({ ydoc }) => persistenceExtension({ ydoc }))
 *   .withExtension('sync', ({ ydoc }) => syncExtension({ ydoc }));
 *
 * 	await workspace.whenReady;
 * ```
 *
 * @param definition - Workspace definition with id, tables, and kv
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtension()
 */
export function createWorkspace<
	const TTableDefinitions extends readonly TableDefinition[],
	const TKvFields extends readonly KvField[],
>(
	definition: WorkspaceDefinition<TTableDefinitions, TKvFields>,
): WorkspaceClientBuilder<TTableDefinitions, TKvFields> {
	const id = definition.id;

	// Create Y.Doc with guid = definition.id
	// gc: true enables garbage collection for efficient YKeyValueLww storage
	const ydoc = new Y.Doc({ guid: id, gc: true });

	// Create table and KV helpers bound to Y.Doc
	const tables = createTables(ydoc, definition.tables ?? []);
	const kv = createKv(ydoc, definition.kv ?? []);

	// Internal state: accumulated cleanup functions and whenReady promises.
	// Shared across the builder chain (same ydoc).
	const extensionCleanups: (() => MaybePromise<void>)[] = [];
	const whenReadyPromises: Promise<unknown>[] = [];

	function buildClient<TExtensions extends Record<string, unknown>>(
		extensions: TExtensions,
	): WorkspaceClientBuilder<TTableDefinitions, TKvFields, TExtensions> {
		const whenReady = Promise.all(whenReadyPromises).then(() => {});

		const destroy = async (): Promise<void> => {
			// Destroy extensions in reverse order (last added = first destroyed)
			for (let i = extensionCleanups.length - 1; i >= 0; i--) {
				await extensionCleanups[i]!();
			}
			ydoc.destroy();
		};

		const client = {
			id,
			ydoc,
			tables,
			kv,
			extensions,
			whenReady,
			destroy,
			[Symbol.asyncDispose]: destroy,
		};

		return Object.assign(client, {
			withExtension<
				TKey extends string,
				TExports extends Record<string, unknown>,
			>(
				key: TKey,
				factory: (
					context: ExtensionContext<TTableDefinitions, TKvFields, TExtensions>,
				) => Extension<TExports>,
			) {
				const result = factory(client);
				extensionCleanups.push(() => result.lifecycle.destroy());
				whenReadyPromises.push(result.lifecycle.whenReady);

				const newExtensions = {
					...extensions,
					[key]: result.exports,
				} as TExtensions & Record<TKey, TExports>;

				return buildClient(newExtensions);
			},
		});
	}

	return buildClient({} as Record<string, never>);
}

export type { WorkspaceClient, WorkspaceClientBuilder };
