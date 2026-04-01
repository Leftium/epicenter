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
 * ## Unlock lifecycle
 *
 * `.withEncryption(config?)` opts the client into encryption. Without it,
 * `workspace.encryption` does not exist on the type.
 *
 * When configured, the full unlock pipeline is:
 * ```
 * workspace.encryption.unlock(userKey)
 *   → byte-level dedup against the active runtime key
 *   → deriveWorkspaceKey(userKey, workspaceId)  // sync HKDF
 *   → apply derived key to all encrypted stores
 *   → set runtime unlock state immediately
 *   → await userKeyStore.set(bytesToBase64(userKey)) if configured
 *
 * Auto-boot (when userKeyStore is provided):
 *   → whenReady: userKeyStore.get()
 *   → if cached key exists: workspace.encryption.unlock(cachedKey)
 *   → if unlock fails: userKeyStore.delete()
 *
 * workspace.encryption.lock()
 *   → clear key + deactivate all stores
 *
 * workspace.clearLocalData()
 *   → workspace.encryption.lock()
 *   → wipe persisted data (clearLocalData callbacks, LIFO)
 *   → await userKeyStore.delete() if configured
 * ```
 *
 * ## Epoch-based compaction
 *
 * Internally, each workspace uses TWO Y.Docs:
 * 1. **Coordination doc** (`guid: workspaceId`) — holds only the epoch map
 * 2. **Data doc** (`guid: \`${workspaceId}-${epoch}\``) — holds tables + KV
 *
 * The coordination doc is purely internal. Consumers interact with the data doc
 * via `client.ydoc`. Calling `client.compact()` migrates all data to a fresh
 * data doc at epoch+1, shedding CRDT history.
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
 *   .withEncryption({ userKeyStore })
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
import { createEpochTracker } from './epoch.js';
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
	TransactionMeta,
	WorkspaceClient,
	WorkspaceClientBuilder,
	WorkspaceDefinition,
	WorkspaceEncryption,
} from './types.js';
import { KV_KEY, TableKey } from './ydoc-keys.js';

/** Byte-level comparison for Uint8Array dedup. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Table observer callback type for tracking across compaction. */
type TableObserverCallback = (
	changedIds: ReadonlySet<string>,
	transaction: TransactionMeta,
) => void;

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
	// ── Coordination doc + epoch tracking ────────────────────────────────
	// The coordination doc is a lightweight Y.Doc that holds only the epoch
	// map. It uses the workspace ID as its GUID (stable anchor for sync).
	// The data doc uses `{workspaceId}-{epoch}` as its GUID.
	const coordYdoc = new Y.Doc({ guid: id });
	const epochTracker = createEpochTracker(coordYdoc);
	const initialEpoch = epochTracker.getEpoch();

	// ── Data doc ────────────────────────────────────────────────────────
	// Mutable — swapped on compact(). All tables, KV, and extensions
	// bind to this doc. The `let` enables compact() to replace it.
	let ydoc = new Y.Doc({ guid: `${id}-${initialEpoch}` });
	let currentDataEpoch = initialEpoch;
	let isCompacting = false;

	const tableDefs = (tablesDef ?? {}) as TTableDefinitions;
	const kvDefs = (kvDef ?? {}) as TKvDefinitions;
	const awarenessDefs = (awarenessDef ?? {}) as TAwarenessDefinitions;

	// ── Encrypted stores ─────────────────────────────────────────────────
	// The workspace owns all encrypted KV stores so it can coordinate
	// activateEncryption across tables and KV simultaneously.
	const encryptedStores: YKeyValueLwwEncrypted<unknown>[] = [];

	// ── Table observer tracking ─────────────────────────────────────────
	// Observers registered via table.observe() are tracked so they can be
	// re-registered on the new table helpers after compact().
	const tableObserverRegistry = new Map<string, Set<TableObserverCallback>>();

	// Create table stores + helpers (one encrypted KV per table)
	const tableHelpers: Record<
		string,
		import('./types.js').TableHelper<BaseRow>
	> = {};
	for (const [name, definition] of Object.entries(tableDefs)) {
		const yarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(TableKey(name));
		const ykv = createEncryptedYkvLww(yarray, { key: options?.key });
		encryptedStores.push(ykv);
		const helper = createTable(ykv, definition);
		tableHelpers[name] = wrapTableWithObserverTracking(name, helper);
	}
	const tables =
		tableHelpers as import('./types.js').TablesHelper<TTableDefinitions>;

	/**
	 * Wrap a table helper's observe method to track callbacks for compact re-registration.
	 * Returns a new object that delegates all calls and tracks observe/unobserve.
	 */
	function wrapTableWithObserverTracking(
		name: string,
		helper: import('./types.js').TableHelper<BaseRow>,
	): import('./types.js').TableHelper<BaseRow> {
		if (!tableObserverRegistry.has(name)) {
			tableObserverRegistry.set(name, new Set());
		}
		const registry = tableObserverRegistry.get(name)!;
		const originalObserve = helper.observe;

		return {
			...helper,
			observe(callback: TableObserverCallback) {
				registry.add(callback);
				const unsub = originalObserve.call(helper, callback);
				return () => {
					registry.delete(callback);
					unsub();
				};
			},
		};
	}

	// Create KV store + helper (single shared encrypted KV)
	const kvYarray = ydoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
	let kvStore = createEncryptedYkvLww(kvYarray, { key: options?.key });
	encryptedStores.push(kvStore);
	let kvHelper = createKv(kvStore, kvDefs);
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
	 * - `clearLocalDataCallbacks` — `workspace.clearLocalData()` data wipe: delete IndexedDB (reversible, repeatable)
	 * - `whenReadyPromises` — construction: composite `whenReady` waits for all extensions to init
	 */
	type BuilderState = {
		extensionCleanups: (() => MaybePromise<void>)[];
		clearLocalDataCallbacks: (() => MaybePromise<void>)[];
		whenReadyPromises: Promise<unknown>[];
	};

	type EncryptionRuntime = {
		encryption: WorkspaceEncryption;
		lock: () => void;
		clearCache: () => Promise<void>;
	};

	// ── Extension factory tracking for compact re-fire ──────────────────
	// When compact() runs, data doc extensions need to be torn down and
	// re-created on the fresh data doc. We store the factory functions
	// (with their keys) so compact() can re-invoke them.
	type StoredExtensionFactory = {
		key: string;
		factory: (context: { ydoc: Y.Doc; whenReady: Promise<void> }) =>
			| (Record<string, unknown> & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearLocalData?: () => MaybePromise<void>;
			  })
			| void;
	};
	const dataDocExtensionFactories: StoredExtensionFactory[] = [];

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

	// ── Data doc swap ──────────────────────────────────────────────────────
	// Shared logic for both compact() (local) and epoch observation (remote).
	// When `dataToWrite` is provided, data is written into the fresh doc.
	// When omitted, the fresh doc starts empty (CRDT sync delivers data).

	async function swapDataDoc(
		newEpoch: number,
		state: BuilderState,
		extensions: Record<string, unknown>,
		dataToWrite?: {
			tables: Record<string, BaseRow[]>;
			kv: Record<string, unknown>;
		},
	) {
		const oldYdoc = ydoc;
		const freshYdoc = new Y.Doc({ guid: `${id}-${newEpoch}` });

		// Create fresh stores + optionally write data
		const newEncryptedStores: YKeyValueLwwEncrypted<unknown>[] = [];

		for (const [name, definition] of Object.entries(tableDefs)) {
			const yarray = freshYdoc.getArray<YKeyValueLwwEntry<unknown>>(
				TableKey(name),
			);
			const newYkv = createEncryptedYkvLww(yarray, {
				key: options?.key,
			});
			newEncryptedStores.push(newYkv);

			const newHelper = createTable(newYkv, definition);
			if (dataToWrite) {
				for (const row of dataToWrite.tables[name] ?? []) {
					newHelper.set(row);
				}
			}

			const wrapped = wrapTableWithObserverTracking(name, newHelper);
			const registry = tableObserverRegistry.get(name);
			if (registry) {
				for (const cb of registry) {
					newHelper.observe(cb);
				}
			}
			tableHelpers[name] = wrapped;
		}

		// Fresh KV store + optionally write data
		const newKvYarray =
			freshYdoc.getArray<YKeyValueLwwEntry<unknown>>(KV_KEY);
		const newKvStore = createEncryptedYkvLww(newKvYarray, {
			key: options?.key,
		});
		newEncryptedStores.push(newKvStore);

		if (dataToWrite) {
			for (const [key, val] of Object.entries(dataToWrite.kv)) {
				newKvStore.set(key, val);
			}
		}

		kvStore = newKvStore;
		kvHelper = createKv(newKvStore, kvDefs);

		// Update encrypted stores
		encryptedStores.length = 0;
		encryptedStores.push(...newEncryptedStores);

		// Dispose old extensions LIFO
		await disposeLifo(state.extensionCleanups);

		// Re-fire extension factories on fresh doc
		state.extensionCleanups.length = 0;
		state.whenReadyPromises.length = 0;

		for (const { key, factory } of dataDocExtensionFactories) {
			try {
				const raw = factory({
					ydoc: freshYdoc,
					whenReady: Promise.resolve(),
				});
				if (!raw) continue;
				const resolved = defineExtension(raw);
				(extensions as Record<string, unknown>)[key] = resolved;
				state.extensionCleanups.push(resolved.dispose);
				state.whenReadyPromises.push(resolved.whenReady);
			} catch (err) {
				console.error(
					`[workspace] Extension '${key}' failed on epoch transition:`,
					err,
				);
			}
		}

		// Wait for new extensions to be ready
		await Promise.all(state.whenReadyPromises);

		// Swap ydoc reference
		ydoc = freshYdoc;
		currentDataEpoch = newEpoch;

		// Destroy old data doc
		oldYdoc.destroy();
	}

	/**
	 * Perform a local compaction: snapshot data, bump epoch, write into fresh doc.
	 */
	async function performCompaction(
		state: BuilderState,
		extensions: Record<string, unknown>,
	) {
		// Snapshot current data
		const tableSnapshots: Record<string, BaseRow[]> = {};
		for (const [name, helper] of Object.entries(tableHelpers)) {
			tableSnapshots[name] = helper.getAllValid();
		}

		const kvSnapshot: Record<string, unknown> = {};
		for (const key of Object.keys(kvDefs)) {
			const raw = kvStore.get(key);
			if (raw !== undefined) {
				kvSnapshot[key] = raw;
			}
		}

		// Bump epoch
		const newEpoch = epochTracker.bumpEpoch();

		// Swap to fresh doc with data
		await swapDataDoc(newEpoch, state, extensions, {
			tables: tableSnapshots,
			kv: kvSnapshot,
		});
	}

	// ── Epoch observation (multi-device) ─────────────────────────────────────
	// When a remote client bumps the epoch, we detect it here and swap
	// to the new data doc. The remote client already seeded the new doc,
	// so we create empty stores and let CRDT sync deliver the data.
	//
	// The callback reference is set by buildClient so it closes over the
	// correct `state` and `extensions` from the final builder.
	let onRemoteEpochChange: ((newEpoch: number) => Promise<void>) | null =
		null;
	const unsubEpochObserver = epochTracker.observeEpoch((newEpoch) => {
		if (isCompacting) return;
		if (newEpoch <= currentDataEpoch) return;
		onRemoteEpochChange?.(newEpoch);
	});
	/**
	 * Build a workspace client with the given extensions and lifecycle state.
	 *
	 * Called once at the bottom of `createWorkspace` (empty state), then once per
	 * `withExtension`/`withWorkspaceExtension` call (accumulated state). Each call
	 * returns a fresh builder object — the client object itself is shared across all
	 * builders (same `ydoc`, `tables`, `kv`), but the builder methods and extensions
	 * map are new.
	 */
	function buildClient<TExtensions extends Record<string, unknown>>({
		extensions,
		state,
		encryptionRuntime,
		actions,
	}: {
		extensions: TExtensions;
		state: BuilderState;
		encryptionRuntime?: EncryptionRuntime;
		actions: Actions;
	}): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions
	> {
		// Wire up epoch observation for this builder's state/extensions.
		// Each buildClient call overwrites the previous — the final builder wins.
		onRemoteEpochChange = async (newEpoch: number) => {
			await swapDataDoc(newEpoch, state, extensions);
		};

		const dispose = async (): Promise<void> => {
			// Stop observing epoch changes
			unsubEpochObserver();
			onRemoteEpochChange = null;
			// Close all documents first (before extensions they depend on)
			for (const cleanup of documentCleanups) {
				await cleanup();
			}
			const errors = await disposeLifo(state.extensionCleanups);
			awareness.raw.destroy();
			coordYdoc.destroy();
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
			get ydoc() {
				return ydoc;
			},
			definitions,
			tables,
			documents: typedDocuments,
			get kv() {
				return kvHelper;
			},
			awareness,
			// Each extension entry is the exports object stored by reference.
			extensions,
			actions,
			/**
			 * Current epoch number.
			 *
			 * The epoch starts at 0 and increments each time `compact()` is called.
			 * The data doc's GUID is `{workspaceId}-{epoch}`.
			 */
			get epoch() {
				return epochTracker.getEpoch();
			},
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
			/**
			 * Get the encoded size of the current data doc in bytes.
			 *
			 * Useful for deciding when to compact. This is the total
			 * CRDT state including history, not just the active data.
			 */
			encodedSize(): number {
				return Y.encodeStateAsUpdate(ydoc).byteLength;
			},
			/**
			 * Compact the workspace by migrating all data to a fresh Y.Doc.
			 *
			 * This creates a new Y.Doc at epoch N+1 with zero CRDT history,
			 * copies all current table rows and KV entries into it, bumps
			 * the epoch in the coordination doc, and tears down the old data doc.
			 *
			 * Other connected clients will see the epoch change via CRDT
			 * sync on the coordination doc and automatically transition.
			 *
			 * @example
			 * ```typescript
			 * const sizeBefore = Y.encodeStateAsUpdate(client.ydoc).byteLength;
			 * await client.compact();
			 * const sizeAfter = Y.encodeStateAsUpdate(client.ydoc).byteLength;
			 * // sizeAfter < sizeBefore (no CRDT history overhead)
			 * ```
			 */
			async compact(): Promise<void> {
				isCompacting = true;
				try {
					await performCompaction(state, extensions);
				} finally {
					isCompacting = false;
				}
			},
			async clearLocalData(): Promise<void> {
				encryptionRuntime?.lock();
				for (let i = state.clearLocalDataCallbacks.length - 1; i >= 0; i--) {
					try {
						await state.clearLocalDataCallbacks[i]?.();
					} catch (err) {
						console.error('Extension clearLocalData error:', err);
					}
				}
				await encryptionRuntime?.clearCache();
			},
			whenReady,
			dispose,
			[Symbol.asyncDispose]: dispose,
		};

		if (encryptionRuntime) {
			Object.assign(client, {
				encryption: encryptionRuntime.encryption,
				async unlockWithKey(userKeyBase64: string) {
					await whenReady;
					await encryptionRuntime.encryption.unlock(
						base64ToBytes(userKeyBase64),
					);
				},
			});
		}

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
				clearLocalData?: () => MaybePromise<void>;
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
				if (!raw)
					return buildClient({ extensions, state, encryptionRuntime, actions });

				const resolved = defineExtension(raw);

				return buildClient({
					extensions: {
						...extensions,
						[key]: resolved,
					} as TExtensions & Record<TKey, TExports>,
					state: {
						extensionCleanups: [...state.extensionCleanups, resolved.dispose],
						clearLocalDataCallbacks: [
							...state.clearLocalDataCallbacks,
							...(resolved.clearLocalData ? [resolved.clearLocalData] : []),
						],
						whenReadyPromises: [...state.whenReadyPromises, resolved.whenReady],
					},
					encryptionRuntime,
					actions,
				});
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
				factory: (context: {
					ydoc: Y.Doc;
					whenReady: Promise<void>;
				}) => TExports & {
					whenReady?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearLocalData?: () => MaybePromise<void>;
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
				// Track for compact re-fire
				dataDocExtensionFactories.push({ key, factory });
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
					clearLocalData?: () => MaybePromise<void>;
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
							clearLocalData?: () => MaybePromise<void>;
					  })
					| void,
				options?: { tags?: string[] },
			) {
				documentExtensionRegistrations.push({
					key,
					factory,
					tags: options?.tags ?? [],
				});
				return buildClient({ extensions, state, encryptionRuntime, actions });
			},

			withEncryption(config?: EncryptionConfig) {
				let activeUserKey: Uint8Array | undefined;
				let isActiveUserKeyCached = config?.userKeyStore === undefined;
				let workspaceKey: Uint8Array | undefined = options?.key;
				let cacheQueue = Promise.resolve();

				const runSerializedCacheTask = async (
					task: () => Promise<void>,
				): Promise<void> => {
					const next = cacheQueue.catch(() => {}).then(task);
					cacheQueue = next.catch(() => {});
					return await next;
				};

				const lock = () => {
					activeUserKey = undefined;
					isActiveUserKeyCached = config?.userKeyStore === undefined;
					workspaceKey = undefined;
					for (const store of encryptedStores) {
						store.deactivateEncryption();
					}
				};

				const persistUnlockedUserKey = async (userKey: Uint8Array) => {
					if (!config?.userKeyStore) return;

					try {
						await runSerializedCacheTask(async () => {
							await config.userKeyStore.set(bytesToBase64(userKey));
							if (
								activeUserKey !== undefined &&
								bytesEqual(activeUserKey, userKey)
							) {
								isActiveUserKeyCached = true;
							}
						});
					} catch (error) {
						console.error('[workspace] User key cache save failed:', error);
					}
				};

				const unlock = async (userKey: Uint8Array) => {
					const isSameUserKey =
						activeUserKey !== undefined && bytesEqual(activeUserKey, userKey);

					if (!isSameUserKey) {
						try {
							const nextWorkspaceKey = deriveWorkspaceKey(userKey, id);
							for (const store of encryptedStores) {
								store.activateEncryption(nextWorkspaceKey);
							}
							workspaceKey = nextWorkspaceKey;
							activeUserKey = userKey;
							isActiveUserKeyCached = config?.userKeyStore === undefined;
						} catch (error) {
							console.error('[workspace] Workspace unlock failed:', error);
							return;
						}
					}

					if (config?.userKeyStore && !isActiveUserKeyCached) {
						await persistUnlockedUserKey(userKey);
					}
				};

				const clearCache = async () => {
					if (!config?.userKeyStore) return;
					await runSerializedCacheTask(async () => {
						await config.userKeyStore.delete();
					});
				};

				const baseEncryption: WorkspaceEncryption = {
					get isUnlocked() {
						return workspaceKey !== undefined;
					},
					unlock,
					lock,
				};

				// Auto-boot: if a key store is provided, attempt unlock from store
				// after all extensions are ready. Passing userKeyStore implies auto-boot.
				if (config?.userKeyStore) {
					const store = config.userKeyStore;
					state.whenReadyPromises.push(
						Promise.all(state.whenReadyPromises).then(async () => {
							const cachedKey = await store.get();
							if (!cachedKey) return;
							try {
								await unlock(base64ToBytes(cachedKey));
							} catch (error) {
								console.error('[workspace] Cached key unlock failed:', error);
								await clearCache();
							}
						}),
					);
				}

				const encryptionRuntime: EncryptionRuntime = {
					encryption: baseEncryption,
					lock,
					clearCache,
				};

				return buildClient({
					extensions,
					state,
					encryptionRuntime,
					actions,
				}) as unknown as WorkspaceClientBuilder<
					TId,
					TTableDefinitions,
					TKvDefinitions,
					TAwarenessDefinitions,
					TExtensions,
					Record<string, never>,
					{
						encryption: typeof encryptionRuntime.encryption;
					}
				>;
			},

			withActions(
				factory: (
					client: WorkspaceClient<
						TId,
						TTableDefinitions,
						TKvDefinitions,
						TAwarenessDefinitions,
						TExtensions
					>,
				) => Actions,
			) {
				const newActions = factory(client);
				return buildClient({
					extensions,
					state,
					encryptionRuntime,
					actions: { ...actions, ...newActions },
				});
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

	return buildClient({
		extensions: {} as Record<string, never>,
		state: {
			extensionCleanups: [],
			clearLocalDataCallbacks: [],
			whenReadyPromises: [],
		},
		actions: {},
	});
}

export type { WorkspaceClient, WorkspaceClientBuilder };
