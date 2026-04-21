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
 * ## Encryption
 *
 * All stores are always wrapped with `createEncryptedYkvLww()` (passthrough when no
 * key is set). After the workspace is ready, call `applyEncryptionKeys()` to activate
 * encryption on all stores. This is synchronous — HKDF and XChaCha20 are both sync.
 *
 * ```
 * workspace.applyEncryptionKeys(session.encryptionKeys);
 * workspace.extensions.sync.connect();
 * ```
 *
 * Once encryption has been activated, the stores permanently refuse plaintext writes.
 * The only reset path is `clearLocalData()`.
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
 *   .withExtension('sync', createSyncExtension({ url, getToken }));
 *
 * // With actions (terminal)
 * const client = createWorkspace({ id: 'my-app', tables: { posts } })
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withActions((client) => ({
 *     createPost: defineMutation({ ... }),
 *   }));
 *
 * // From a reusable definition object
 * const def: WorkspaceDefinition<'my-app', ...> = { id: 'my-app', tables: { posts } };
 * const client = createWorkspace(def);
 * ```
 */

import {
	attachAwareness,
	type Awareness,
	type AwarenessDefinitions,
	type Kv,
	type KvDefinitions,
	type TableDefinitions,
	type Tables,
} from '@epicenter/document';
import type { Awareness as YAwareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import {
	attachEncryptedKv,
	attachEncryptedTables,
} from './attach-encrypted.js';
import { attachEncryption } from './attach-encryption.js';
import type { EncryptionKeys } from './encryption-key.js';
import {
	defineExtension,
	disposeLifo,
	type MaybePromise,
	type RawExtension,
	startDisposeLifo,
} from './lifecycle.js';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Minimal context shape needed by extensions that only use ydoc + awareness + init.
 *
 * Structural subset of `ExtensionContext`. Extensions like sync/persistence
 * only need these three fields; typing their factory argument with this
 * narrower shape keeps them generic across workspace definitions.
 *
 * ```typescript
 * // Sync needs ydoc + raw awareness + init:
 * .withExtension('sync', ({ ydoc, awareness, init }) => {
 *   return createProvider({ doc: ydoc, awareness: awareness.raw, waitFor: init });
 * })
 * ```
 */
export type SharedExtensionContext = {
	ydoc: Y.Doc;
	awareness: { raw: YAwareness };
	/**
	 * Framework chain signal — resolves once every prior extension's `init`
	 * promise has resolved. Use to sequence initialization across the chain.
	 */
	init: Promise<void>;
};

/**
 * Context passed to workspace extension factories.
 *
 * This is a `WorkspaceClient` minus lifecycle methods (`dispose`, the composite
 * `whenReady`) plus the framework-internal `init` chain signal — extension
 * factories receive the full client surface but don't control the workspace's
 * lifecycle. They return their own lifecycle hooks instead.
 *
 * ```typescript
 * .withExtension('persistence', ({ ydoc }) => { ... })
 * .withExtension('sync', ({ ydoc, awareness, init }) => { ... })
 * .withExtension('sqlite', ({ id, tables }) => { ... })
 * ```
 *
 * `init` is the composite chain signal from all PRIOR extensions — use it to
 * sequence initialization (e.g., wait for persistence before connecting sync).
 *
 * `extensions` provides typed access to prior extensions' exports.
 */
export type ExtensionContext<
	TId extends string = string,
	TTableDefinitions extends TableDefinitions = TableDefinitions,
	TKvDefinitions extends KvDefinitions = KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions = AwarenessDefinitions,
	TExtensions extends Record<string, unknown> = Record<string, unknown>,
> = Omit<
	WorkspaceClient<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions
	>,
	'dispose' | 'whenReady' | typeof Symbol.asyncDispose
> & {
	/**
	 * Framework chain signal — resolves once every prior extension's `init`
	 * promise has resolved. Use to sequence initialization across the chain.
	 */
	init: Promise<void>;
};

/** The workspace client returned by createWorkspace() */
export type WorkspaceClient<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown>,
> = {
	/** Workspace identifier */
	id: TId;
	/** The underlying Y.Doc instance */
	ydoc: Y.Doc;
	/** Workspace definitions for introspection */
	definitions: {
		tables: TTableDefinitions;
		kv: TKvDefinitions;
		awareness: TAwarenessDefinitions;
	};
	/** Typed table helpers — CRUD operations per table. */
	tables: Tables<TTableDefinitions>;
	/** Typed KV helper */
	kv: Kv<TKvDefinitions>;
	/** Typed awareness helper — always present, like tables and kv */
	awareness: Awareness<TAwarenessDefinitions>;
	/**
	 * Extension exports (accumulated via `.withExtension()` calls).
	 *
	 * Each entry is the exports object returned by the extension factory.
	 * Access exports directly — no wrapper:
	 *
	 * ```typescript
	 * client.extensions.persistence.clearLocalData();
	 * client.extensions.sqlite.db.query('SELECT ...');
	 * ```
	 *
	 * Use `client.whenReady` to wait for all extensions to initialize.
	 */
	extensions: TExtensions;

	/**
	 * Execute multiple operations atomically in a single Y.js transaction.
	 *
	 * Groups all table and KV mutations inside the callback into one transaction.
	 * This means:
	 * - Observers fire once (not per-operation)
	 * - Creates a single undo/redo step
	 * - All changes are applied together
	 *
	 * The callback receives nothing because `tables` and `kv` are the same objects
	 * whether you're inside `batch()` or not — `ydoc.transact()` makes ALL operations
	 * on the shared doc atomic automatically. No special transactional wrapper needed.
	 *
	 * **Note**: Yjs transactions do NOT roll back on error. If the callback throws,
	 * any mutations that already executed within the callback are still applied.
	 *
	 * Nested `batch()` calls are safe — Yjs transact is reentrant, so inner calls
	 * are absorbed by the outer transaction.
	 *
	 * @param fn - Callback containing table/KV operations to batch
	 */
	batch(fn: () => void): void;

	/**
	 * Apply a binary Y.js update to the underlying document.
	 *
	 * Use this to hydrate the workspace from a persisted snapshot (e.g. a `.yjs`
	 * file on disk) without exposing the raw Y.Doc to consumer code.
	 *
	 * @param update - A Uint8Array produced by `Y.encodeStateAsUpdate()` or equivalent
	 */
	loadSnapshot(update: Uint8Array): void;

	/**
	 * Apply encryption keys to all stores.
	 *
	 * Decodes base64 user keys, derives per-workspace keys via HKDF-SHA256,
	 * and activates encryption on all stores. Once activated, stores permanently
	 * refuse plaintext writes — the only reset path is `clearLocalData()`.
	 *
	 * This method is synchronous — HKDF via @noble/hashes and XChaCha20 via
	 * @noble/ciphers are both sync. Call it after persistence is ready but
	 * before connecting sync.
	 *
	 * @param keys - Non-empty array of versioned user keys from the auth session
	 */
	applyEncryptionKeys(keys: EncryptionKeys): void;

	/**
	 * Wipe local workspace data.
	 *
	 * Calls extension `clearLocalData()` hooks in LIFO order.
	 */
	clearLocalData(): Promise<void>;

	/**
	 * Resolves when every extension's `init` chain signal has resolved. Use as
	 * a render gate — after this resolves, all persistence has loaded, all
	 * materializers have flushed, and all sync transports have connected (per
	 * each extension's contract).
	 */
	whenReady: Promise<void>;

	/**
	 * Release all resources—data is preserved on disk.
	 *
	 * Calls `dispose()` on every extension in LIFO order (last registered, first disposed).
	 * Stops observers, closes database connections, disconnects sync providers.
	 *
	 * After calling, the client is unusable.
	 *
	 * Safe to call multiple times (idempotent).
	 */
	dispose(): Promise<void>;

	/** Async dispose support */
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Definition for a workspace, separated from instantiation.
 *
 * This is a pure data structure for composability and type inference.
 * Pass to createWorkspace() to instantiate.
 */
export type WorkspaceDefinition<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
> = {
	id: TId;
	tables?: TTableDefinitions;
	kv?: TKvDefinitions;
	/** Record of awareness field schemas. Each field has its own StandardSchemaV1 schema. */
	awareness?: TAwarenessDefinitions;
	/**
	 * Yjs garbage collection for the workspace Y.Doc. Omit to use the
	 * sync-safe default (`false`), which keeps deletion markers so peers that
	 * haven't seen the deletes yet can still reconcile. Set `true` for purely
	 * local workspaces where memory pressure matters more than sync safety.
	 */
	gc?: boolean;
};

/**
 * Builder returned by `createWorkspace()` and by each `.withExtension()` call.
 *
 * IS a usable client AND has `.withExtension()` + `.withActions()`.
 */
export type WorkspaceClientBuilder<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
	TExtensions extends Record<string, unknown> = Record<string, never>,
	TActions extends Actions = Record<string, never>,
> = WorkspaceClient<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions,
	TExtensions
> & {
	/** Accumulated actions from `.withActions()` calls. Empty object when none declared. */
	actions: TActions;

	/**
	 * Register a workspace extension.
	 *
	 * The factory receives the full workspace context (tables, KV, awareness,
	 * prior extensions). Extensions initialize in registration order; each
	 * factory sees a `whenReady` promise that resolves when all previously
	 * registered extensions have finished their own init.
	 */
	withExtension<TKey extends string, TExports extends Record<string, unknown>>(
		key: TKey,
		factory: (
			context: ExtensionContext<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				TAwarenessDefinitions,
				TExtensions
			>,
		) => RawExtension<TExports> | void,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions & Record<TKey, TExports>,
		TActions
	>;

	/**
	 * Attach actions to the workspace client.
	 */
	withActions<TNewActions extends Actions>(
		factory: (
			client: WorkspaceClient<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				TAwarenessDefinitions,
				TExtensions
			>,
		) => TNewActions,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions,
		TActions & TNewActions
	>;
};

/**
 * Type alias for any workspace client (used for duck-typing in CLI/server).
 */
export type AnyWorkspaceClient = WorkspaceClient<
	string,
	TableDefinitions,
	KvDefinitions,
	AwarenessDefinitions,
	Record<string, unknown>
> & {
	actions?: Actions;
};

/**
 * Create a workspace client with chainable extension support.
 *
 * The returned client IS directly usable (no extensions required) AND supports
 * chaining `.withExtension()` calls to progressively add extensions, each with
 * typed access to all previously added extensions.
 *
 * Single code path — no overloads, no branches. Awareness is always created
 * as a single instance regardless of how many fields are defined. When no
 * awareness fields are defined, the helper has zero accessible field keys
 * but `raw` is still available for sync providers.
 *
 * @param def - Workspace definition (id + schemas).
 * @returns WorkspaceClientBuilder - a client that can be used directly or chained with .withExtension()
 */
export function createWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
>(
	def: WorkspaceDefinition<
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
	const {
		id,
		tables: tableDefs = {} as TTableDefinitions,
		kv: kvDefs = {} as TKvDefinitions,
		awareness: awarenessDefs = {} as TAwarenessDefinitions,
		// gc defaults to false — deletion-marker GC breaks sync with peers that
		// haven't seen the deletes yet. Opt in only for purely local docs.
		gc = false,
	} = def;

	// Each createWorkspace invocation builds its own Y.Doc, so no cache or
	// refcounting is needed — dispose tears down the doc directly.
	const ydoc = new Y.Doc({ guid: id, gc });
	const encryption = attachEncryption(ydoc);
	const tables = attachEncryptedTables(ydoc, encryption, tableDefs);
	const kv = attachEncryptedKv(ydoc, encryption, kvDefs);
	const awareness = attachAwareness(ydoc, awarenessDefs);

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
	 * - `initPromises` — construction: composite `whenReady` waits for every extension's `init` to resolve
	 */
	type BuilderState = {
		extensionCleanups: (() => MaybePromise<void>)[];
		clearLocalDataCallbacks: (() => MaybePromise<void>)[];
		initPromises: Promise<unknown>[];
	};

	/**
	 * Build a workspace client with the given extensions and lifecycle state.
	 *
	 * Called once at the bottom of `createWorkspace` (empty state), then once per
	 * `withExtension` call (accumulated state). Each call
	 * returns a fresh builder object — the client object itself is shared across all
	 * builders (same `ydoc`, `tables`, `kv`), but the builder methods and extensions
	 * map are new.
	 */
	function buildClient<TExtensions extends Record<string, unknown>>({
		extensions,
		state,
		actions,
	}: {
		extensions: TExtensions;
		state: BuilderState;
		actions: Actions;
	}): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions
	> {
		const dispose = async (): Promise<void> => {
			const errors = await disposeLifo(state.extensionCleanups);
			// Destroy the Y.Doc — cascades to every attached provider and
			// resolves `encryption.whenDisposed` once every encrypted store
			// has settled.
			ydoc.destroy();
			await encryption.whenDisposed;

			if (errors.length > 0) {
				throw new AggregateError(
					errors,
					`${errors.length} extension(s) failed during dispose`,
				);
			}
		};

		const whenReady = Promise.all(state.initPromises)
			.then(() => {})
			.catch(async (err) => {
				// If any extension's init rejects, clean up everything
				await dispose().catch(() => {}); // idempotent
				throw err;
			});

		const client = {
			id,
			ydoc,
			definitions,
			tables,
			kv,
			awareness,
			// Each extension entry is the exports object stored by reference.
			extensions,
			actions,
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
			 * Useful for monitoring doc growth. This is the total
			 * CRDT state including history, not just the active data.
			 */
			encodedSize(): number {
				return Y.encodeStateAsUpdate(ydoc).byteLength;
			},
			/**
			 * Apply encryption keys to all stores.
			 *
			 * Decodes base64 user keys, derives per-workspace keys via HKDF-SHA256,
			 * and activates encryption on all stores. Once activated, stores permanently
			 * refuse plaintext writes — the only reset path is `clearLocalData()`.
			 *
			 * This method is synchronous — HKDF via @noble/hashes and XChaCha20 via
			 * @noble/ciphers are both sync. Call it after persistence is ready but
			 * before connecting sync.
			 *
			 * @param keys - Non-empty array of versioned user keys from the auth session
			 *
			 * @example
			 * ```typescript
			 * await workspace.whenReady;
			 * workspace.applyEncryptionKeys(session.encryptionKeys);
			 * workspace.extensions.sync.connect();
			 * ```
			 */
			applyEncryptionKeys(keys: EncryptionKeys): void {
				encryption.applyKeys(keys);
			},
			async clearLocalData(): Promise<void> {
				for (let i = state.clearLocalDataCallbacks.length - 1; i >= 0; i--) {
					try {
						await state.clearLocalDataCallbacks[i]?.();
					} catch (err) {
						console.error('Extension clearLocalData error:', err);
					}
				}
			},
			whenReady,
			dispose,
			[Symbol.asyncDispose]: dispose,
		};

		/**
		 * Apply an extension factory to the workspace Y.Doc.
		 *
		 * Each factory receives the full workspace context (tables, KV, awareness,
		 * prior extensions). The framework accumulates dispose, clearLocalData, and
		 * init hooks into the builder state.
		 */
		function applyExtension<
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
			) => RawExtension<TExports> | void,
		) {
			const {
				dispose: _dispose,
				[Symbol.asyncDispose]: _asyncDispose,
				whenReady: _whenReady,
				...clientContext
			} = client;
			const ctx = {
				...clientContext,
				init:
					state.initPromises.length === 0
						? Promise.resolve()
						: Promise.all(state.initPromises).then(() => {}),
			};

			try {
				const raw = factory(ctx);

				// Void return means "not installed" — skip registration
				if (!raw) return buildClient({ extensions, state, actions });

				const { exports, init, dispose, clearLocalData, onActive } =
					defineExtension(raw);

				// At the workspace scope the extension is always considered
				// active — there is no bind/release lifecycle here, so call
				// `onActive` once after `init` resolves. Idle-able extensions
				// (sync) use this signal to start their work; extensions
				// without the hook are unaffected.
				//
				// Failures in `onActive` are logged rather than propagated so
				// they don't abort workspace bootstrap. If the extension
				// actually can't start, it'll surface that via its own status
				// API (e.g., `sync.status.phase === 'connecting'` hanging).
				const readyInit = onActive
					? init.then(() => {
							try {
								onActive();
							} catch (err) {
								console.error(
									`Workspace extension '${key}' onActive error:`,
									err,
								);
							}
						})
					: init;

				return buildClient({
					extensions: {
						...extensions,
						[key]: exports,
					} as TExtensions & Record<TKey, TExports>,
					state: {
						extensionCleanups: [...state.extensionCleanups, dispose],
						clearLocalDataCallbacks: [
							...state.clearLocalDataCallbacks,
							...(clearLocalData ? [clearLocalData] : []),
						],
						initPromises: [...state.initPromises, readyInit],
					},
					actions,
				});
			} catch (err) {
				startDisposeLifo(state.extensionCleanups);
				throw err;
			}
		}

		const builder = Object.assign(client, {
			/**
			 * Register a workspace extension.
			 *
			 * Extensions initialize in registration order. The factory receives a
			 * `whenReady` promise that resolves when all previously registered
			 * extensions have finished initializing. Extensions that await this
			 * promise create a sequential dependency; extensions that ignore it
			 * run in parallel with earlier ones.
			 *
			 * The typical chain is persistence → encryption/unlock → sync.
			 * Persistence loads local state first, so sync only exchanges the
			 * delta with the server.
			 *
			 * @example
			 * ```typescript
			 * createWorkspace(definition)
			 *   .withExtension('persistence', indexeddbPersistence)
			 *   .withExtension('sync', createSyncExtension({ url: ... }))
			 * ```
			 */
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
				) => RawExtension<TExports> | void,
			) {
				return applyExtension(key, factory);
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
				const allActions = { ...actions, ...newActions };

				// Wire actions into the sync extension for inbound RPC dispatch.
				// The sync extension is registered before actions (it needs to connect
				// first), so we push actions to it after the fact.
				//
				// TODO: This is an invisible contract — workspace assumes a sync
				// extension is registered under the key `'sync'` with a
				// `registerActions(actions)` method. If either is renamed, actions
				// silently never reach the sync layer. Replace with a generic
				// `onActions(actions)` hook on the RawExtension shape so any
				// extension can opt in without string coupling.
				const sync = (extensions as Record<string, any>).sync;
				if (typeof sync?.registerActions === 'function') {
					sync.registerActions(allActions);
				}

				return buildClient({
					extensions,
					state,
					actions: allActions,
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
			initPromises: [],
		},
		actions: {},
	});
}
