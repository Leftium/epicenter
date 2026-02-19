/**
 * createWorkspace() - Instantiate a workspace client.
 *
 * Returns a client that IS usable directly AND has `.withExtension()` for chaining.
 *
 * ## Extension chaining vs action maps
 *
 * Extensions use chainable `.withExtension(key, factory)` because they build on each
 * other progressively — each factory receives previously added extensions as typed context.
 * You may be importing extensions you don't control and want to compose on top of them.
 *
 * Actions use a single `.withActions(factory)` because they don't build on each other,
 * are always defined by the app author, and benefit from being declared in one place.
 *
 * @example
 * ```typescript
 * // Direct use (no extensions)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } });
 * client.tables.posts.set({ id: '1', title: 'Hello' });
 *
 * // With extensions (chained)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', ySweetSync({ auth: directAuth('...') }));
 *
 * // With actions (terminal)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withActions((client) => ({
 *     createPost: defineMutation({ ... }),
 *   }));
 *
 * // From reusable definition
 * const def = defineWorkspace({ id: 'my-app', tables: { posts } });
 * const client = createWorkspace(def);
 * ```
 */

import * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type {
	DocumentContext,
	DocumentLifecycle,
	Extension,
	MaybePromise,
} from '../shared/lifecycle.js';
import { createAwareness } from './create-awareness.js';
import { createDocumentBinding } from './create-document-binding.js';
import { createKv } from './create-kv.js';
import { createTables } from './create-tables.js';
import type {
	AwarenessDefinitions,
	DocBinding,
	DocumentBinding,
	ExtensionContext,
	KvDefinitions,
	TableDefinitions,
	TableHelper,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceClientWithActions,
	WorkspaceDefinition,
} from './types.js';

/**
 * Create a workspace client with chainable extension support.
 *
 * The returned client IS directly usable (no extensions required) AND supports
 * chaining `.withExtension()` calls to progressively add extensions, each with
 * typed access to all previously added extensions.
 *
 * Single code path — no overloads, no branches. Awareness is always created
 * (like tables and KV). When no awareness fields are defined, the helper has
 * zero accessible field keys but `raw` is still available for sync providers.
 *
 * @param config - Workspace config (or WorkspaceDefinition from defineWorkspace())
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtension()
 */
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
>(
	config: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions
	>,
): WorkspaceClientBuilder<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	Record<string, never>
> {
	const { id } = config;
	const ydoc = new Y.Doc({ guid: id });
	const tableDefs = (config.tables ?? {}) as TTableDefinitions;
	const kvDefs = (config.kv ?? {}) as TKvDefinitions;
	const awarenessDefs = (config.awareness ?? {}) as TAwarenessDefinitions;

	const tables = createTables(ydoc, tableDefs);
	const kv = createKv(ydoc, kvDefs);
	const awareness = createAwareness(ydoc, awarenessDefs);
	const definitions = {
		tables: tableDefs,
		kv: kvDefs,
		awareness: awarenessDefs,
	};

	// Internal state: accumulated cleanup functions and whenReady promises.
	// Shared across the builder chain (same ydoc).
	const extensionCleanups: (() => MaybePromise<void>)[] = [];
	const whenReadyPromises: Promise<unknown>[] = [];

	// Accumulated onDocumentOpen callbacks from extensions (in chain order).
	// Mutable array — grows as .withExtension() is called. Document bindings
	// reference this array, so by the time user code calls .open(), all
	// extensions' onDocumentOpen hooks are registered.
	const documentOpenHooks: ((
		context: DocumentContext,
	) => DocumentLifecycle | void)[] = [];

	// Create document bindings for tables that have .withDocument() declarations.
	// Bindings are created eagerly but reference documentOpenHooks by closure,
	// so they pick up hooks from extensions added later.
	const documentBindingCleanups: (() => Promise<void>)[] = [];

	for (const [tableName, tableDef] of Object.entries(tableDefs)) {
		const docsDef = (
			tableDef as { docs?: Record<string, DocBinding<string, string>> }
		).docs;
		if (!docsDef || Object.keys(docsDef).length === 0) continue;

		const tableHelper = (
			tables as Record<string, TableHelper<{ id: string; _v: number }>>
		)[tableName];
		if (!tableHelper) continue;

		const docsNamespace: Record<
			string,
			DocumentBinding<{ id: string; _v: number }>
		> = {};

		for (const [docName, docBinding] of Object.entries(docsDef)) {
			const binding = createDocumentBinding({
				guidKey: docBinding.guid as keyof { id: string; _v: number } & string,
				updatedAtKey: docBinding.updatedAt as keyof { id: string; _v: number } &
					string,
				tableHelper,
				ydoc,
				onDocumentOpen: documentOpenHooks,
				tableName,
				documentName: docName,
			});

			docsNamespace[docName] = binding;
			documentBindingCleanups.push(() => binding.destroyAll());
		}

		// Attach .docs namespace to the table helper
		Object.defineProperty(tableHelper, 'docs', {
			value: docsNamespace,
			enumerable: true,
			configurable: false,
			writable: false,
		});
	}

	function buildClient<TExtensions extends Record<string, unknown>>(
		extensions: TExtensions,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions
	> {
		const whenReady = Promise.all(whenReadyPromises).then(() => {});

		const destroy = async (): Promise<void> => {
			// Destroy document bindings first (before extensions they depend on)
			for (const cleanup of documentBindingCleanups) {
				await cleanup();
			}
			// Destroy extensions in reverse order (last added = first destroyed)
			for (let i = extensionCleanups.length - 1; i >= 0; i--) {
				await extensionCleanups[i]!();
			}
			// Destroy awareness
			awareness.raw.destroy();
			ydoc.destroy();
		};

		const client = {
			id,
			ydoc,
			definitions,
			tables,
			kv,
			awareness,
			extensions,
			batch(fn: () => void): void {
				ydoc.transact(fn);
			},
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
					context: ExtensionContext<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TAwarenessDefinitions,
						TExtensions
					>,
				) => Extension<TExports>,
			) {
				const result = factory(client);
				const destroy = result.lifecycle?.destroy;
				if (destroy) extensionCleanups.push(destroy);
				whenReadyPromises.push(
					result.lifecycle?.whenReady ?? Promise.resolve(),
				);

				// Collect onDocumentOpen hooks for document bindings
				if (result.onDocumentOpen) {
					documentOpenHooks.push(result.onDocumentOpen);
				}

				const newExtensions = {
					...extensions,
					[key]: result.exports ?? {},
				} as TExtensions & Record<TKey, TExports>;

				return buildClient(newExtensions);
			},

			withActions<TActions extends Actions>(
				factory: (
					client: WorkspaceClient<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TAwarenessDefinitions,
						TExtensions
					>,
				) => TActions,
			) {
				const actions = factory(client);
				return {
					...client,
					actions,
				} as WorkspaceClientWithActions<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TAwarenessDefinitions,
					TExtensions,
					TActions
				>;
			},
		});
	}

	return buildClient({} as Record<string, never>);
}

export type { WorkspaceClient, WorkspaceClientBuilder };
