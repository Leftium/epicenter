/**
 * Shared types for the Workspace API.
 *
 * This module contains all type definitions for versioned tables and KV stores.
 *
 * The lower-level CRDT primitive types (`TableDefinition`, `Table`,
 * `KvDefinition`, `Kv`, `AwarenessDefinitions`, `Awareness`,
 * `BaseRow`, etc.) live in `@epicenter/document` and are re-exported below.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	Awareness,
	AwarenessDefinitions,
	BaseRow,
	CombinedStandardSchema,
	Kv,
	KvDefinitions,
	LastSchema,
	Tables,
} from '@epicenter/document';
import type { Awareness as YAwareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type { EncryptionKeys } from './encryption-key.js';
import type { RawExtension } from './lifecycle.js';

// Re-export JSON types for consumers
export type { JsonObject, JsonValue } from 'wellcrafted/json';

// Re-export primitive types from document so downstream imports keep working.
//
// `TableDefinition` and `TableDefinitions` are NOT re-exported from document:
// workspace's `TableDefinition` has a wider `documents` field constrained to
// `Record<string, DocumentConfig>` (with the workspace-specific DocumentConfig
// type). Workspace's wider type is structurally assignable to document's
// narrower `Record<string, unknown>` definition, so attachTable/etc. accept
// it transparently.
export type {
	Awareness,
	AwarenessDefinitions,
	AwarenessState,
	BaseRow,
	CombinedStandardSchema,
	ContentHandle,
	ContentStrategy,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	Kv,
	KvChange,
	KvDefinition,
	KvDefinitions,
	LastSchema,
	NotFoundResult,
	PlainTextAttachment,
	RichTextAttachment,
	RowResult,
	Table,
	Tables,
	UpdateResult,
	ValidRowResult,
} from '@epicenter/document';

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A table definition created by `defineTable(schema)` or `defineTable(v1, v2, ...).migrate(fn)`.
 *
 * @typeParam TVersions - Tuple of schema versions (each must include `{ id: string }`)
 */
export type TableDefinition<
	TVersions extends readonly CombinedStandardSchema<BaseRow>[],
> = {
	schema: CombinedStandardSchema<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		row: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
};

/**
 * Extract keys of `TRow` whose value type extends `string`.
 */
export type StringKeysOf<TRow> = {
	[K in keyof TRow & string]: TRow[K] extends string ? K : never;
}[keyof TRow & string];

/**
 * Workspace's `Tables<TTableDefinitions>`, now equivalent to the document-package Tables helper.
 *
 * Kept as a re-export alias so downstream code that imports `WorkspaceTables`
 * continues to compile. Equivalent to `Tables<TTableDefinitions>`.
 */
export type WorkspaceTables<TTableDefinitions extends TableDefinitions> =
	Tables<TTableDefinitions>;

/**
 * Map of table definitions keyed by table name.
 */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any>
>;

// ════════════════════════════════════════════════════════════════════════════
// EXTENSION TYPES
// ════════════════════════════════════════════════════════════════════════════

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
 * Factory function that creates an extension.
 *
 * Returns a flat object with custom exports + optional `init` (framework chain
 * signal), `dispose`, and `clearLocalData`. The framework normalizes defaults
 * via `defineExtension()`.
 *
 * @example Simple extension (works with any workspace)
 * ```typescript
 * const persistence: ExtensionFactory = ({ ydoc }) => {
 *   const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
 *   return {
 *     exports: { whenLoaded: provider.whenSynced },
 *     init: provider.whenSynced,
 *     dispose: () => provider.destroy(),
 *   };
 * };
 * ```
 *
 * @typeParam TExports - The consumer-facing exports object type
 */
export type ExtensionFactory<
	TExports extends Record<string, unknown> = Record<string, unknown>,
> = (context: ExtensionContext) => RawExtension<TExports>;

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
	/** Typed table helpers — CRUD plus a `.documents` sub-namespace when the table has `.withDocument()` declarations */
	tables: WorkspaceTables<TTableDefinitions>;
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
	 *
	 * @example Single table batching
	 * ```typescript
	 * client.batch(() => {
	 *   client.tables.posts.set({ id: '1', title: 'First' });
	 *   client.tables.posts.set({ id: '2', title: 'Second' });
	 *   client.tables.posts.delete('3');
	 * });
	 * // Observer fires once with all 3 changed IDs
	 * ```
	 *
	 * @example Cross-table + KV batching
	 * ```typescript
	 * client.batch(() => {
	 *   client.tables.tabs.set({ id: '1', url: 'https://...' });
	 *   client.tables.windows.set({ id: 'w1', name: 'Main' });
	 *   client.kv.set('lastSync', new Date().toISOString());
	 * });
	 * // All three writes are one atomic transaction
	 * ```
	 *
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
	 *
	 * @example
	 * ```typescript
	 * await workspace.whenReady;
	 * workspace.applyEncryptionKeys(session.encryptionKeys);
	 * workspace.extensions.sync.connect();
	 * ```
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
	 *
	 * @example
	 * ```svelte
	 * {#await client.whenReady}
	 *   <Loading />
	 * {:then}
	 *   <App />
	 * {/await}
	 * ```
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
