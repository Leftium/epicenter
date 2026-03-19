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
 * `.withEncryption(config?)` opts the client into encryption. Without it, encryption
 * methods (`activateEncryption`, `deactivateEncryption`, `isEncrypted`) don't exist
 * on the type — Whispering and CLI never see them.
 *
 * When configured, the full activation pipeline is:
 * ```
 * activateEncryption(userKey)
 *   → byte-level dedup (same key? skip)
 *   → ++generation (race protection)
 *   → await deriveWorkspaceKey(userKey, workspaceId)  // HKDF
 *   → stale check (generation changed? discard)
 *   → apply derived key to all encrypted stores
 *   → await onActivate hook (e.g. cache user key)
 *
 * deactivateEncryption()
 *   → ++generation (invalidate in-flight HKDF)
 *   → clear key + deactivate all stores
 *   → wipe persisted data (clearData callbacks, LIFO)
 *   → await onDeactivate hook (e.g. clear key cache)
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
 *   .withEncryption({
 *     onActivate: (userKey) => keyCache.save(bytesToBase64(userKey)),
 *     onDeactivate: () => keyCache.clear(),
 *   })
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
import { deriveWorkspaceKey } from '../shared/crypto/index.js';
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
	EncryptionMethods,
	ExtensionContext,
	KvDefinitions,
	TableDefinitions,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceClientWithActions,
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
	/** Whether a key has been provided — the single source of truth for encryption state. */
	let workspaceKey: Uint8Array | undefined = options?.key;

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
	 * - `clearDataCallbacks` — `deactivateEncryption()` data wipe: delete IndexedDB (reversible, repeatable)
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
				// Private closure state — inaccessible from outside.
				// lastUserKey: enables byte-level dedup (same key → skip HKDF).
				// keyGeneration: monotonic counter for race protection. Each call to
				//   activateEncryption or deactivateEncryption increments it. When HKDF
				//   resolves, the generation is compared — if it changed, a newer call
				//   superseded this one and the stale result is discarded.
				let lastUserKey: Uint8Array | undefined;
				let keyGeneration = 0;

				Object.defineProperty(client, 'isEncrypted', {
					get() {
						return workspaceKey !== undefined;
					},
					enumerable: true,
					configurable: true,
				});

				Object.assign(client, {
					// Activation pipeline:
					//   1. Byte-level dedup (same key bytes → early return, no work)
					//   2. ++generation (race protection)
					//   3. HKDF: deriveWorkspaceKey(userKey, workspaceId) → derived key
					//   4. Stale check (generation changed during HKDF → discard)
					//   5. Apply derived key to all encrypted stores
					//   6. onActivate hook (e.g. cache the user key for sidebar reopens)
					//
					// Why the generation counter matters: HKDF is async. If the user signs
					// out and back in during derivation, a slow HKDF from the old key could
					// resolve after the new key is already active. The generation check at
					// step 4 catches this — the stale result is silently discarded.
					async activateEncryption(userKey: Uint8Array) {
						if (lastUserKey && bytesEqual(lastUserKey, userKey)) return;
						lastUserKey = userKey;

						const thisGen = ++keyGeneration;
						try {
							const wsKey = await deriveWorkspaceKey(userKey, id);
							if (thisGen !== keyGeneration) return;
							workspaceKey = wsKey;
							for (const store of encryptedStores) {
								store.activateEncryption(wsKey);
							}
							await config?.onActivate?.(userKey);
						} catch (error) {
							console.error('[workspace] Key derivation failed:', error);
						}
					},
					// Deactivation pipeline:
					//   1. ++generation (invalidates any in-flight HKDF from activateEncryption)
					//   2. Clear lastUserKey and workspaceKey
					//   3. Deactivate all stores (switch back to plaintext mode)
					//   4. Wipe persisted data via clearData callbacks (LIFO order)
					//   5. Call onDeactivate hook (e.g. keyCache.clear())
					//
					// Step 1 is critical: if activateEncryption is mid-HKDF when deactivate
					// is called, the generation bump ensures the in-flight derivation's
					// result is discarded when it resolves. Without this, the sequence
					// activate → deactivate could end with encryption re-enabled by the
					// stale HKDF completing after deactivation.
					async deactivateEncryption() {
						++keyGeneration;
						lastUserKey = undefined;
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
						await config?.onDeactivate?.();
					},
				});

				return builder as unknown as WorkspaceClientBuilder<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TAwarenessDefinitions,
					TExtensions,
					Record<string, never>,
					EncryptionMethods
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
