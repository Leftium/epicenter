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
 * // From reusable definition
 * const def = defineWorkspace({ id: 'my-app', tables: { posts } });
 * const client = createWorkspace(def);
 * ```
 */

import * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import { defineWorkspace, type WorkspaceFactory } from './define-workspace.js';
import type { EncryptionKeys } from './encryption-key.js';
import {
	defineExtension,
	disposeLifo,
	type MaybePromise,
	type RawExtension,
	startDisposeLifo,
} from './lifecycle.js';
import type {
	AwarenessDefinitions,
	ExtensionContext,
	KvDefinitions,
	TableDefinitions,
	WorkspaceClient,
	WorkspaceClientBuilder,
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
 * as a single instance regardless of how many fields are defined. When no
 * awareness fields are defined, the helper has zero accessible field keys
 * but `raw` is still available for sync providers.
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
	arg:
		| WorkspaceDefinition<
				TId,
				TTableDefinitions,
				TKvDefinitions,
				TAwarenessDefinitions
		  >
		| WorkspaceFactory<
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
	// Accept either a raw WorkspaceDefinition (legacy) or the new
	// `defineWorkspace()` factory output. The factory carries `.definition`
	// as metadata so we can recover the original schema either way.
	const def: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions
	> = 'definition' in arg ? arg.definition : arg;

	// Per-call factory: each createWorkspace invocation builds its own Y.Doc,
	// matching the pre-refactor semantics. Apps that want shared-doc behavior
	// call `defineWorkspace(def).open(id)` directly.
	const factory = defineWorkspace(def);
	const { id } = def;
	const handle = factory.open(id);
	const { ydoc, tables, kv, awareness, encryption } = handle;

	const definitions = {
		tables: def.tables ?? ({} as TTableDefinitions),
		kv: def.kv ?? ({} as TKvDefinitions),
		awareness: (def.awareness ?? {}) as TAwarenessDefinitions,
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
			// Release our handle and force the factory to tear the bundle
			// down — gcTime is Infinity so refcount→0 alone doesn't evict.
			// factory.close awaits `bundle.whenDisposed`, which resolves once
			// every encrypted store has settled.
			handle.dispose();
			await factory.close(id);

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
