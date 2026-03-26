/**
 * createWorkspace() — Instantiate a workspace client.
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
 * ## Encryption lifecycle
 *
 * `.withEncryption(config?)` opts the client into encryption. Without it,
 * `workspace.encryption` does not exist on the type.
 *
 * When configured, the full activation pipeline is:
 * ```
 * workspace.encryption.activate(userKey)
 *   → byte-level dedup (same runtime key + persisted cache? skip)
 *   → deriveWorkspaceKey(userKey, workspaceId)  // sync HKDF
 *   → apply derived key to all encrypted stores
 *   → set runtime encryption state immediately
 *   → await userKeyCache.save(bytesToBase64(userKey)) if configured
 *
 * workspace.encryption.restoreEncryptionFromCache()
 *   → userKeyCache.load() if configured
 *   → base64ToBytes(cachedUserKey)
 *   → workspace.encryption.activate(userKey)
 *
 * workspace.encryption.deactivate()
 *   → clear key + deactivate all stores
 *   → wipe persisted data (clearData callbacks, LIFO)
 *   → await userKeyCache.clear() if configured
 * ```
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
 * // With encryption + extensions
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withEncryption({ userKeyCache })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({ ... }));
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
import {
	base64ToBytes,
	bytesToBase64,
	deriveWorkspaceKey,
} from '../shared/crypto/index.js';
import type { YKeyValueLwwEntry } from '../shared/y-keyvalue/y-keyvalue-lww.js';
import {
	createEncryptedYkvLww,
	type YKeyValueLwwEncrypted,
} from '../shared/y-keyvalue/y-keyvalue-lww-encrypted.js';
import { createAwareness } from './create-awareness.js';
import { createDocuments } from './create-document.js';
import { createKv } from './create-kv.js';
import { createTable } from './create-table.js';
import {
	defineExtension,
	disposeLifo,
	type MaybePromise,
	startDisposeLifo,
} from './lifecycle.js';
import type {
	AwarenessDefinitions,
	BaseRow,
	DocumentConfig,
	DocumentContext,
	DocumentExtensionRegistration,
	Documents,
	DocumentsHelper,
	EncryptionConfig,
	ExtensionContext,
	KvDefinitions,
	TableDefinitions,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceClientWithActions,
	WorkspaceEncryptionController,
	WorkspaceDefinition,
} from './types.js';
import { KV_KEY, TableKey } from './ydoc-keys.js';


/** Byte-level comparison for Uint8Array dedup. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

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
	{
		id,
		tables: tablesDef,
		kv: kvDef,
		awareness: awarenessDef,
	}: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions
	>,
	options?: { key?: Uint8Array },
): WorkspaceClientBuilder<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	Record<string, never>
> {
	const ydoc = new Y.Doc({ guid: id });
	const tableDefs = (tablesDef ?? {}) as TTableDefinitions;
	const kvDefs = (kvDef ?? {}) as TKvDefinitions;
	const awarenessDefs = (awarenessDef ?? {}) as TAwarenessDefinitions;

	// ── Encrypted stores ─────────────────────────────────────────────────
	// The workspace owns all encrypted KV stores so it can coordinate
	// activateEncryption across tables and KV simultaneously.
	const encryptedStores: YKeyValueLwwEncrypted<unknown>[] = [];

	// Create table stores + helpers (one encrypted KV per table)
	const tableHelpers: Record<
		string,
		import('./types.js').TableHelper<BaseRow>
	> = {};
	for (const [name, definition] of Object.entries(tableDefs)) {
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
		const ykv = createEncryptedYkvLww(yarray, { key: options?.key });
		encryptedStores.push(ykv);
		tableHelpers[name] = createTable(ykv, definition);
	}
	const tables =
		tableHelpers as import('./types.js').TablesHelper<TTableDefinitions>;

	// Create KV store + helper (single shared encrypted KV)
	const kvYarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	const kvStore = createEncryptedYkvLww(kvYarray, { key: options?.key });
	encryptedStores.push(kvStore);
	const kv = createKv(kvStore, kvDefs);
	const awareness = createAwareness(ydoc, awarenessDefs);
	const definitions = {
		tables: tableDefs,
		kv: kvDefs,
		awareness: awarenessDefs,
	};

	/**
	 * Immutable builder state passed through the builder chain.
	 *
	 * Each `withExtension` creates new arrays instead of mutating shared state,
	 * which fixes builder branching isolation (two branches from the same base
	 * builder get independent extension sets).
	 *
	 * Three arrays track three distinct lifecycle moments:
	 * - `extensionCleanups` — `dispose()` shutdown: close connections, stop observers (irreversible)
	 * - `clearDataCallbacks` — `workspace.encryption.deactivate()` data wipe: delete IndexedDB (reversible, repeatable)
	 * - `whenReadyPromises` — construction: composite `whenReady` waits for all extensions to init
	 */
	type BuilderState = {
		extensionCleanups: (() => MaybePromise<void>)[];
		clearDataCallbacks: (() => MaybePromise<void>)[];
		whenReadyPromises: Promise<unknown>[];
	};

	// Accumulated document extension registrations (in chain order).
	// Mutable array — grows as .withDocumentExtension() is called. Document
	// bindings reference this array by closure, so by the time user code
	// calls .open(), all extensions are registered.
	const documentExtensionRegistrations: DocumentExtensionRegistration[] = [];

	// Create documents for tables that have .withDocument() declarations.
	// Documents are created eagerly but reference documentExtensionRegistrations by closure,
	// so they pick up extensions added later via .withDocumentExtension().
	const documentCleanups: (() => Promise<void>)[] = [];
	// Runtime type is Record<string, Record<string, Documents<BaseRow>>> —
	// cast to DocumentsHelper at the end so it satisfies WorkspaceClient/ExtensionContext.
	const documentsNamespace: Record<
		string,
		Record<string, Documents<BaseRow>>
	> = {};

	for (const [tableName, tableDef] of Object.entries(tableDefs)) {
		if (Object.keys(tableDef.documents).length === 0) continue;

		const tableHelper = tables[tableName];
		if (!tableHelper) continue;

		const tableDocumentsNamespace: Record<string, Documents<BaseRow>> = {};

		for (const [docName, _documentConfig] of Object.entries(
			tableDef.documents,
		)) {
			const documentConfig = _documentConfig as DocumentConfig;
			const docTags: readonly string[] = documentConfig.tags ?? [];

			const documents = createDocuments({
				id,
				guidKey: documentConfig.guid as keyof BaseRow & string,
				onUpdate: documentConfig.onUpdate,
				tableHelper,
				ydoc,
				documentExtensions: documentExtensionRegistrations,
				documentTags: docTags,
			});

			tableDocumentsNamespace[docName] = documents;
			documentCleanups.push(() => documents.closeAll());
		}

		documentsNamespace[tableName] = tableDocumentsNamespace;
	}

	const typedDocuments =
		documentsNamespace as unknown as DocumentsHelper<TTableDefinitions>;

	/**
	 * Build a workspace client with the given extensions and lifecycle state.
	 *
	 * Called once at the bottom of `createWorkspace` (empty state), then once per
	 * `withExtension`/`withWorkspaceExtension` call (accumulated state). Each call
	 * returns a fresh builder object — the client object itself is shared across all
	 * builders (same `ydoc`, `tables`, `kv`), but the builder methods and extensions
	 * map are new.
	 */
	function buildClient<TExtensions extends Record<string, unknown>>(
		extensions: TExtensions,
		state: BuilderState,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions
	> {
		const dispose = async (): Promise<void> => {
			// Close all documents first (before extensions they depend on)
			for (const cleanup of documentCleanups) {
				await cleanup();
			}
			const errors = await disposeLifo(state.extensionCleanups);
			awareness.raw.destroy();
			ydoc.destroy();

			if (errors.length > 0) {
				throw new Error(`Extension cleanup errors: ${errors.length}`);
			}
		};

		const whenReady = Promise.all(state.whenReadyPromises)
			.then(() => {})
			.catch(async (err) => {
				// If any extension's whenReady rejects, clean up everything
				await dispose().catch(() => {}); // idempotent
				throw err;
			});

		const client = {
			id,
			ydoc,
			definitions,
			tables,
			documents: typedDocuments,
			kv,
			awareness,
			// Each extension entry is the exports object stored by reference.
			extensions,
			batch(fn: () => void): void {
				ydoc.transact(fn);
			},
			/**
			 * Apply a binary Y.js update to the underlying document.
			 *
			 * Use this to hydrate the workspace from a persisted snapshot (e.g. a `.yjs`
			 * file on disk) without exposing the raw Y.Doc to consumer code.
			 *
			 * @param update - A Uint8Array produced by `Y.encodeStateAsUpdate()` or equivalent
			 */
			loadSnapshot(update: Uint8Array): void {
				Y.applyUpdate(ydoc, update);
			},
			whenReady,
			dispose,
			[Symbol.asyncDispose]: dispose,
		};

		/**
		 * Apply an extension factory to the workspace Y.Doc.
		 *
		 * Shared by `withExtension` and `withWorkspaceExtension` — the only
		 * difference is whether `withExtension` also registers the factory for
		 * document Y.Docs (fired lazily at `documents.open()` time).
		 */
		function applyWorkspaceExtension<
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
			) => TExports & {
				whenReady?: Promise<unknown>;
				dispose?: () => MaybePromise<void>;
				clearData?: () => MaybePromise<void>;
			},
		) {
			const {
				dispose: _dispose,
				[Symbol.asyncDispose]: _asyncDispose,
				whenReady: _whenReady,
				...clientContext
			} = client;
			const ctx = {
				...clientContext,
				whenReady:
					state.whenReadyPromises.length === 0
						? Promise.resolve()
						: Promise.all(state.whenReadyPromises).then(() => {}),
			};

			try {
				const raw = factory(ctx);

				// Void return means "not installed" — skip registration
				if (!raw) return buildClient(extensions, state);

				const resolved = defineExtension(raw);

				return buildClient(
					{
						...extensions,
						[key]: resolved,
					} as TExtensions & Record<TKey, TExports>,
					{
						extensionCleanups: [...state.extensionCleanups, resolved.dispose],
						clearDataCallbacks: [
							...state.clearDataCallbacks,
							...(resolved.clearData ? [resolved.clearData] : []),
						],
						whenReadyPromises: [...state.whenReadyPromises, resolved.whenReady],
					},
				);
			} catch (err) {
				startDisposeLifo(state.extensionCleanups);
				throw err;
			}
		}

		// The builder methods use generics at the type level for progressive accumulation,
		// but the runtime implementations use wider types for storage (registrations array).
		// The cast at the end bridges the gap — type safety is enforced at call sites.
		const builder = Object.assign(client, {
			withExtension<
				TKey extends string,
				TExports extends Record<string, unknown>,
			>(
				key: TKey,
				factory: (context: { ydoc: Y.Doc; whenReady: Promise<void> }) => TExports & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearData?: () => MaybePromise<void>;
				},
			) {
				// Sugar: register for both scopes with the same factory.
				// The factory only receives SharedExtensionContext (ydoc + whenReady),
				// which is a structural subset of both ExtensionContext and DocumentContext.
				documentExtensionRegistrations.push({
					key,
					factory,
					tags: [],
				});
				return applyWorkspaceExtension(key, factory);
			},

			withWorkspaceExtension<
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
				) => TExports & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearData?: () => MaybePromise<void>;
				},
			) {
				return applyWorkspaceExtension(key, factory);
			},

			withDocumentExtension(
				key: string,
				factory: (context: DocumentContext) =>
					| (Record<string, unknown> & {
							whenReady?: Promise<unknown>;
							dispose?: () => MaybePromise<void>;
							clearData?: () => MaybePromise<void>;
					  })
					| void,
				options?: { tags?: string[] },
			) {
				documentExtensionRegistrations.push({
					key,
					factory,
					tags: options?.tags ?? [],
				});
				return buildClient(extensions, state);
			},

			withEncryption(config?: EncryptionConfig) {
				function createEncryptionController(): WorkspaceEncryptionController {
					// Private closure state — inaccessible from outside.
					// activeUserKey tracks the runtime root key currently applied to stores.
					// persistedUserKey tracks which root key has successfully crossed the
					// async cache boundary. Splitting them keeps runtime unlock synchronous
					// while same-key save failures still retry honestly.
					let activeUserKey: Uint8Array | undefined;
					let persistedUserKey: Uint8Array | undefined;
					let pendingPersistedUserKey: Uint8Array | undefined;
					let persistenceVersion = 0;
					let persistenceQueue = Promise.resolve();
					let workspaceKey: Uint8Array | undefined = options?.key;

					const runSerializedPersistence = async (
						task: () => Promise<void>,
					): Promise<void> => {
						const next = persistenceQueue.catch(() => {}).then(task);
						persistenceQueue = next.catch(() => {});
						return await next;
					};

					// Activation pipeline:
					//   1. Skip only when the same runtime key is already active AND the
					//      cache already reflects that key (or no cache exists)
					//   2. HKDF: deriveWorkspaceKey(userKey, workspaceId) → derived key
					//   3. Apply the derived key to all encrypted stores synchronously
					//   4. Update runtime encryption state synchronously
					//   5. Serialize cache persistence so save/clear ordering matches the
					//      latest activation or deactivation request
					const activate = async (userKey: Uint8Array) => {
						const hasPersistedKey =
							config?.userKeyCache === undefined ||
							(persistedUserKey !== undefined &&
								bytesEqual(persistedUserKey, userKey));
						if (
							activeUserKey !== undefined &&
							bytesEqual(activeUserKey, userKey) &&
							hasPersistedKey
						) {
							return;
						}

						try {
							const nextWorkspaceKey = deriveWorkspaceKey(userKey, id);
							for (const store of encryptedStores) {
								store.activateEncryption(nextWorkspaceKey);
							}
							workspaceKey = nextWorkspaceKey;
							activeUserKey = userKey;
						} catch (error) {
							console.error('[workspace] Encryption activation failed:', error);
							return;
						}

						if (!config?.userKeyCache) {
							persistedUserKey = userKey;
							pendingPersistedUserKey = undefined;
							return;
						}

						if (
							pendingPersistedUserKey !== undefined &&
							bytesEqual(pendingPersistedUserKey, userKey)
						) {
							return await persistenceQueue;
						}

						const persistenceToken = ++persistenceVersion;
						pendingPersistedUserKey = userKey;
						try {
							await runSerializedPersistence(async () => {
								await config.userKeyCache?.save(bytesToBase64(userKey));
								if (
									persistenceToken === persistenceVersion &&
									activeUserKey !== undefined &&
									bytesEqual(activeUserKey, userKey)
								) {
									persistedUserKey = userKey;
								}
							});
						} catch (error) {
							console.error('[workspace] User key cache save failed:', error);
						} finally {
							if (
								pendingPersistedUserKey !== undefined &&
								bytesEqual(pendingPersistedUserKey, userKey)
							) {
								pendingPersistedUserKey = undefined;
							}
						}
					};

					// Restore pipeline:
					//   1. Return false when no userKeyCache exists
					//   2. Load cached base64 user key
					//   3. Return false when nothing is cached
					//   4. Decode the cached user key
					//   5. Re-enter activate so restore shares the same runtime and cache
					//      ordering behavior as normal sign-in
					//
					// Corrupt cache entries are cleared so startup does not keep retrying
					// the same bad value on every reload.
					const restoreEncryptionFromCache = async () => {
						if (workspaceKey !== undefined) return true;
						if (!config?.userKeyCache) return false;

						const cachedUserKey = await config.userKeyCache.load();
						if (!cachedUserKey) return false;

						try {
							await activate(base64ToBytes(cachedUserKey));
							return workspaceKey !== undefined;
						} catch (error) {
							console.error('[workspace] Cached key restore failed:', error);
							await config.userKeyCache.clear();
							return false;
						}
					};

					// Deactivation pipeline:
					//   1. Clear runtime key state synchronously
					//   2. Deactivate all stores synchronously
					//   3. Wipe persisted data via clearData callbacks (LIFO order)
					//   4. Serialize userKeyCache.clear() after any in-flight saves so the
					//      final cache state matches the latest lifecycle transition
					const deactivate = async () => {
						++persistenceVersion;
						activeUserKey = undefined;
						persistedUserKey = undefined;
						pendingPersistedUserKey = undefined;
						workspaceKey = undefined;
						for (const store of encryptedStores) {
							store.deactivateEncryption();
						}
						for (let i = state.clearDataCallbacks.length - 1; i >= 0; i--) {
							try {
								await state.clearDataCallbacks[i]?.();
							} catch (err) {
								console.error('Extension clearData error:', err);
							}
						}
						await runSerializedPersistence(async () => {
							await config?.userKeyCache?.clear();
						});
					};

					return {
						get isEncrypted() {
							return workspaceKey !== undefined;
						},
						activate,
						restoreEncryptionFromCache,
						deactivate,
					};
				}

				const encryption = createEncryptionController();
				Object.assign(client, { encryption });

				return builder as unknown as WorkspaceClientBuilder<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TAwarenessDefinitions,
					TExtensions,
					Record<string, never>,
					{ encryption: WorkspaceEncryptionController }
				>;
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
				} as unknown as WorkspaceClientWithActions<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TAwarenessDefinitions,
					TExtensions,
					TActions
				>;
			},
		});

		return builder as unknown as WorkspaceClientBuilder<
			TId,
			TTableDefinitions,
			TKvDefinitions,
			TAwarenessDefinitions,
			TExtensions
		>;
	}

	return buildClient({} as Record<string, never>, {
		extensionCleanups: [],
		clearDataCallbacks: [],
		whenReadyPromises: [],
	});
}

export type { WorkspaceClient, WorkspaceClientBuilder };
