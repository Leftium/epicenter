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

import type { StandardSchemaV1 } from '@standard-schema/spec';
import * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type { Extension, MaybePromise } from '../shared/lifecycle.js';
import { createAwareness } from './create-awareness.js';
import { createKv } from './create-kv.js';
import { createTables } from './create-tables.js';
import type {
	ExtensionContext,
	KvDefinitions,
	TableDefinitions,
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
 * @param config - Workspace config (or WorkspaceDefinition from defineWorkspace())
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtension()
 */
// Overload: With awareness schema
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	const TAwareness extends StandardSchemaV1 = StandardSchemaV1,
>(
	config: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwareness
	>,
): WorkspaceClientBuilder<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwareness,
	Record<string, never>
>;

// Overload: Without awareness schema
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
>(
	config: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		undefined
	>,
): WorkspaceClientBuilder<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	undefined,
	Record<string, never>
>;

// Implementation signature (private)
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwareness extends StandardSchemaV1 | undefined = undefined,
>(
	config: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwareness
	>,
): WorkspaceClientBuilder<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwareness,
	Record<string, never>
> {
	const { id } = config;
	const ydoc = new Y.Doc({ guid: id });
	const tableDefs = (config.tables ?? {}) as TTableDefinitions;
	const kvDefs = (config.kv ?? {}) as TKvDefinitions;
	const tables = createTables(ydoc, tableDefs);
	const kv = createKv(ydoc, kvDefs);
	const definitions = { tables: tableDefs, kv: kvDefs };

	// Internal state: accumulated cleanup functions and whenReady promises.
	// Shared across the builder chain (same ydoc).
	const extensionCleanups: (() => MaybePromise<void>)[] = [];
	const whenReadyPromises: Promise<unknown>[] = [];

	// Branch: No awareness schema
	if (config.awareness === undefined) {
		function buildClient<TExtensions extends Record<string, unknown>>(
			extensions: TExtensions,
		): WorkspaceClientBuilder<
			TId,
			TTableDefinitions,
			TKvDefinitions,
			undefined,
			TExtensions
		> {
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
				definitions,
				extensions,
				awareness: undefined,
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
							undefined,
							TExtensions
						>,
					) => Extension<TExports>,
				) {
					const context = {
						id,
						ydoc,
						tables,
						kv,
						extensions,
						awareness: undefined,
					};

					const result = factory(context);
					extensionCleanups.push(() => result.lifecycle.destroy());
					whenReadyPromises.push(result.lifecycle.whenReady);

					const newExtensions = {
						...extensions,
						[key]: result.exports,
					} as TExtensions & Record<TKey, TExports>;

					return buildClient(newExtensions);
				},

				withActions<TActions extends Actions>(
					factory: (
						client: WorkspaceClient<
							TId,
							TTableDefinitions,
							TKvDefinitions,
							undefined,
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
						undefined,
						TExtensions,
						TActions
					>;
				},
			});
		}

		return buildClient({} as Record<string, never>) as WorkspaceClientBuilder<
			TId,
			TTableDefinitions,
			TKvDefinitions,
			TAwareness,
			Record<string, never>
		>;
	}

	// Branch: With awareness schema
	// At runtime we know config.awareness is not undefined here
	// But TypeScript still sees TAwareness as potentially undefined
	// So we assert the types explicitly
	type AwarenessType = TAwareness extends StandardSchemaV1
		? StandardSchemaV1.InferOutput<TAwareness>
		: never;
	const awareness = createAwareness(
		ydoc,
		config.awareness as StandardSchemaV1<unknown, AwarenessType>,
	);

	function buildClient<TExtensions extends Record<string, unknown>>(
		extensions: TExtensions,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwareness,
		TExtensions
	> {
		const whenReady = Promise.all(whenReadyPromises).then(() => {});

		const destroy = async (): Promise<void> => {
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
			tables,
			kv,
			definitions,
			extensions,
			awareness: awareness as any,
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
						TAwareness,
						TExtensions
					>,
				) => Extension<TExports>,
			) {
				const context = {
					id,
					ydoc,
					tables,
					kv,
					extensions,
					awareness: awareness as any,
				};

				const result = factory(context);
				extensionCleanups.push(() => result.lifecycle.destroy());
				whenReadyPromises.push(result.lifecycle.whenReady);

				const newExtensions = {
					...extensions,
					[key]: result.exports,
				} as TExtensions & Record<TKey, TExports>;

				return buildClient(newExtensions);
			},

			withActions<TActions extends Actions>(
				factory: (
					client: WorkspaceClient<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TAwareness,
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
					TAwareness,
					TExtensions,
					TActions
				>;
			},
		});
	}

	return buildClient({} as Record<string, never>) as WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwareness,
		Record<string, never>
	>;
}

export type { WorkspaceClient, WorkspaceClientBuilder };
