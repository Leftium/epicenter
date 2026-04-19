/**
 * Shared types for the Workspace API.
 *
 * This module contains all type definitions for versioned tables and KV stores.
 *
 * The lower-level CRDT primitive types (`TableDefinition`, `TableHelper`,
 * `KvDefinition`, `KvHelper`, `AwarenessDefinitions`, `AwarenessHelper`,
 * `BaseRow`, etc.) live in `@epicenter/document` and are re-exported below.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	AwarenessDefinitions,
	AwarenessHelper,
	BaseRow,
	CombinedStandardSchema,
	KvDefinitions,
	KvHelper,
	LastSchema,
	TablesHelper,
} from '@epicenter/document';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import type { Actions } from '../shared/actions.js';
import type { EncryptionKeys } from './encryption-key.js';
import type { Extension, MaybePromise } from './lifecycle.js';

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
	AwarenessDefinitions,
	AwarenessHelper,
	AwarenessState,
	BaseRow,
	CombinedStandardSchema,
	GetResult,
	InferAwarenessValue,
	InferKvValue,
	InferTableRow,
	InvalidRowResult,
	KvChange,
	KvDefinition,
	KvDefinitions,
	KvHelper,
	LastSchema,
	NotFoundResult,
	RowResult,
	TableHelper,
	TablesHelper,
	UpdateResult,
	ValidRowResult,
} from '@epicenter/document';

// ════════════════════════════════════════════════════════════════════════════
// TABLE DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A table definition created by `defineTable(schema)` or `defineTable(v1, v2, ...).migrate(fn)`.
 *
 * Workspace's variant of `TableDefinition` constrains `TDocuments` to
 * `Record<string, DocumentConfig>` so `.withDocument()` accumulates
 * fully-typed document configs. Structurally compatible with the wider
 * `TableDefinition` exported from `@epicenter/document` (which uses
 * `Record<string, unknown>` since it has no notion of DocumentConfig).
 *
 * @typeParam TVersions - Tuple of schema versions (each must include `{ id: string }`)
 * @typeParam TDocuments - Record of named document configs declared via `.withDocument()`
 */
export type TableDefinition<
	TVersions extends readonly CombinedStandardSchema<BaseRow>[],
	TDocuments extends Record<string, DocumentConfig> = Record<string, never>,
> = {
	schema: CombinedStandardSchema<
		unknown,
		StandardSchemaV1.InferOutput<TVersions[number]>
	>;
	migrate: (
		row: StandardSchemaV1.InferOutput<TVersions[number]>,
	) => StandardSchemaV1.InferOutput<LastSchema<TVersions>>;
	documents: TDocuments;
};

/**
 * A content strategy factory — receives a content Y.Doc and returns a typed binding.
 *
 * The binding is whatever the strategy wants to expose: a Y.Text for plain text,
 * a Y.XmlFragment for rich text, or a custom object with methods for complex
 * content types like chat trees.
 *
 * Called once per document open. Each call gets a fresh Y.Doc.
 *
 * @example
 * ```typescript
 * // Simple: return a Y.Text
 * const myStrategy: ContentStrategy<Y.Text> = (ydoc) => ydoc.getText('content');
 *
 * // Complex: return a custom binding object
 * const chatTree: ContentStrategy<ChatTreeBinding> = (ydoc) => ({
 *   nodes: ydoc.getMap('nodes'),
 *   addMessage(msg) {
 *     // ...
 *   },
 * });
 * ```
 */
export type ContentStrategy<TBinding extends ContentHandle = ContentHandle> = (ydoc: Y.Doc) => TBinding;

/**
 * Base contract every content strategy must satisfy.
 *
 * Consumers can always `read()` and `write()` regardless of strategy.
 * This ensures no consumer ever needs direct `ydoc` access for basic
 * content operations — the strategy encapsulates `transact()` internally.
 */
export type ContentHandle = {
	read(): string;
	write(text: string): void;
};

/**
 * Plain text content handle — wraps Y.Text with read/write and a binding getter.
 *
 * The `binding` property exposes the raw Y.Text for editor integration
 * (CodeMirror via y-codemirror, Monaco, etc.). Use `read()`/`write()`
 * for programmatic access; use `binding` when wiring up an editor.
 */
export type PlainTextHandle = ContentHandle & {
	/** The raw Y.Text for editor binding (CodeMirror, Monaco, etc.). */
	binding: Y.Text;
};

/**
 * Rich text content handle — wraps Y.XmlFragment with read/write and a binding getter.
 *
 * The `binding` property exposes the raw Y.XmlFragment for ProseMirror/TipTap
 * integration via y-prosemirror. Use `read()`/`write()` for programmatic access;
 * use `binding` when wiring up a block editor.
 */
export type RichTextHandle = ContentHandle & {
	/** The raw Y.XmlFragment for editor binding (ProseMirror, TipTap, etc.). */
	binding: Y.XmlFragment;
};

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT CONFIG TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * A named document declared via `.withDocument()`.
 *
 * Maps a document concept (e.g., 'content') to a GUID column and an `onUpdate` callback
 * that fires whenever the content Y.Doc changes -- both local edits and remote sync updates.
 *
 * - `guid`: The column storing the Y.Doc GUID (must be a string column)
 * - `onUpdate`: Zero-argument callback returning `Partial<Omit<TRow, 'id'>>` -- the fields
 *   to write when the doc changes. Must return at least one field so the table row actually
 *   changes and `table.observe` fires. Returning `{}` is a no-op that silently breaks
 *   downstream observers (materializers, indexes) that depend on the table observer.
 *
 * @typeParam TGuid - Literal string type of the guid column name
 * @typeParam TRow - The row type of the table (used to type-check `onUpdate` return)
 */
export type DocumentConfig<
	TGuid extends string = string,
	TRow extends BaseRow = BaseRow,
	TBinding extends ContentHandle = ContentHandle,
> = {
	/** Content strategy — receives the document Y.Doc, returns the content object from `open()`. */
	content: ContentStrategy<TBinding>;
	guid: TGuid;
	/**
	 * Called on every content Y.Doc change (local and remote). Return the
	 * fields to write to the table row -- typically `{ updatedAt: now() }`.
	 * The row write fires `table.observe`, which is how materializers and
	 * other consumers learn that content changed. Return at least one field.
	 */
	onUpdate: () => Partial<Omit<TRow, 'id'>>;
};

/**
 * Internal registration for a document extension.
 *
 * Stored in an array by `withDocumentExtension()`. Each entry contains
 * the extension key and factory function.
 *
 * At document open time, the runtime calls every registered factory.
 * Factories receive `DocumentContext` with `tableName` and `documentName`
 * and can return `void` to opt out for specific documents.
 */
export type DocumentExtensionRegistration = {
	key: string;
	factory: (context: DocumentContext) =>
		| (Record<string, unknown> & {
				init?: Promise<unknown>;
				dispose?: () => MaybePromise<void>;
				clearLocalData?: () => MaybePromise<void>;
		  })
		| void;
};

/**
 * Extract keys of `TRow` whose value type extends `string`.
 * Used to constrain the `guid` parameter of `.withDocument()`.
 */
export type StringKeysOf<TRow> = {
	[K in keyof TRow & string]: TRow[K] extends string ? K : never;
}[keyof TRow & string];

/**
 * Collect all column names already claimed as `guid` by prior `.withDocument()` calls.
 * Subsequent calls cannot reuse these columns, preventing two documents from sharing
 * a GUID (which would cause storage collisions).
 *
 * With the `onUpdate` callback model, updatedAt columns are no longer claimed —
 * multiple documents can write to the same column via their callbacks (last write wins).
 *
 * Requires `{}` (not `Record<string, never>`) as the initial empty `TDocuments`,
 * so that `keyof {}` = `never` and the union resolves cleanly.
 */
export type ClaimedDocumentColumns<
	TDocuments extends Record<string, DocumentConfig>,
> = TDocuments[keyof TDocuments]['guid'];

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENT CONTEXT — What extension factories receive at document open time
// ════════════════════════════════════════════════════════════════════════════

/**
 * Context passed to document extension factories registered via `withDocumentExtension()`.
 *
 * Contains the fields extension factories need to inspect and operate on an open
 * content document. Factories inspect `tableName` and `documentName` to decide
 * whether to activate. Return `void` to skip a specific document.
 *
 * Excludes `content` (the typed binding consumers use) and `dispose()` (lifecycle
 * managed by the runtime) — factories don't need either.
 *
 * ```typescript
 * .withDocumentExtension('persistence', ({ ydoc }) => { ... })
 * .withDocumentExtension('sync', ({ id, tableName, documentName, ydoc }) => { ... })
 * ```
 *
 * @typeParam TDocExtensions - Accumulated document extension exports from prior calls.
 *   Defaults to `Record<string, unknown>` so `DocumentExtensionRegistration` can
 *   store factories with the wide type.
 */
export type DocumentContext<
	TDocExtensions extends Record<string, unknown> = Record<string, unknown>,
> = {
	/** The workspace identifier. */
	id: string;
	/** The table this document belongs to (e.g., 'files', 'notes'). */
	tableName: string;
	/** The document name declared via `.withDocument()` (e.g., 'content', 'body'). */
	documentName: string;
	/** The content Y.Doc this document is bound to. */
	ydoc: Y.Doc;
	/**
	 * Accumulated document extension exports with lifecycle hooks.
	 *
	 * Each entry is optional because extension factories may return `void`
	 * to skip specific documents. Guard access with optional chaining.
	 */
	extensions: {
		[K in keyof TDocExtensions]?: Extension<
			TDocExtensions[K] extends Record<string, unknown>
				? TDocExtensions[K]
				: Record<string, unknown>
		>;
	};
	/**
	 * Framework chain signal — resolves once all prior document extensions'
	 * `init` promises have resolved. Use to sequence extensions that must run
	 * after a prior one finishes initializing.
	 */
	init: Promise<void>;
	/**
	 * Raw awareness instance for this document scope.
	 *
	 * Uses a minimal wrapper (`{ raw }`) so document and workspace scopes
	 * share the same structural contract for `withExtension()` factories.
	 */
	awareness: { raw: Awareness };
};


/**
 * Runtime manager for a table's associated content Y.Docs.
 *
 * Manages Y.Doc creation, provider lifecycle, `updatedAt` auto-bumping,
 * and cleanup on row deletion. Most users access this via
 * `client.documents.files.content`.
 *
 * `open()` returns the content object directly — fully typed by the content
 * strategy. Infrastructure (ydoc, awareness, extensions) is managed internally.
 *
 * @typeParam TRow - The row type of the bound table
 * @typeParam TBinding - The content binding type from the content strategy
 */
export type Documents<
	TRow extends BaseRow,
	TBinding = ContentHandle,
> = {
	/**
	 * Open a content Y.Doc for a row and return the content object directly.
	 *
	 * Creates the Y.Doc if it doesn't exist, wires up providers, and attaches
	 * the updatedAt observer. Idempotent — calling open() twice for the same
	 * row returns the same content reference (same Y.Doc underneath).
	 *
	 * The returned object is fully typed by the content strategy:
	 * - `plainText` → `PlainTextHandle` with `read()`, `write()`, `binding`
	 * - `richText` → `RichTextHandle` with `read()`, `write()`, `binding`
	 * - `timeline` → `Timeline` with `read()`, `write()`, `asText()`, etc.
	 *
	 * @param input - A row (extracts GUID from the bound column) or a GUID string
	 */
	open(input: TRow | string): Promise<TBinding>;

	/**
	 * Close a document — free memory, disconnect providers.
	 * Persisted data is NOT deleted. The doc can be re-opened later.
	 *
	 * @param input - A row or GUID string
	 */
	close(input: TRow | string): Promise<void>;

	/**
	 * Close all open documents. Called automatically by workspace dispose().
	 */
	closeAll(): Promise<void>;
};

/**
 * Does this table definition have a non-empty `documents` record?
 *
 * Used by `DocumentsHelper` to filter the `documents` namespace — only tables
 * with `.withDocument()` declarations appear in `client.documents`.
 */
export type HasDocuments<T> = T extends { documents: infer TDocuments }
	? keyof TDocuments extends never
		? false
		: true
	: false;

/**
 * Extract all document names across all tables.
 *
 * Collects all document names (from `.withDocument()` calls) into a union
 * for type-safe autocomplete in `withDocumentExtension()` factory context.
 *
 * @example
 * ```typescript
 * // Given tables with .withDocument('content') and .withDocument('body'):
 * type Names = AllDocumentNames<typeof tables>;
 * // => 'content' | 'body'
 * ```
 */
export type AllDocumentNames<TTableDefs extends TableDefinitions> = {
	[K in keyof TTableDefs]: TTableDefs[K] extends {
		documents: infer TDocuments;
	}
		? keyof TDocuments & string
		: never;
}[keyof TTableDefs];

/** Extract the content binding type from a DocumentConfig. */
type InferDocumentBinding<T> = T extends DocumentConfig<
	string,
	BaseRow,
	infer TBinding
>
	? TBinding
	: unknown;

/**
 * Extract the document map for a single table definition.
 *
 * Maps each doc name to a `Documents<TLatest>` where `TLatest` is the
 * table's latest row type (inferred from the `migrate` function's return type).
 */
export type DocumentsOf<T> = T extends {
	documents: infer TDocuments;
	migrate: (...args: never[]) => infer TLatest;
}
	? TLatest extends BaseRow
		? {
				[K in keyof TDocuments]: Documents<
					TLatest,
					InferDocumentBinding<TDocuments[K]>
				>;
			}
		: never
	: never;

/**
 * Top-level document namespace — parallel to `TablesHelper`.
 *
 * Only includes tables that have document configs declared via `.withDocument()`.
 * Tables without documents are filtered out via key remapping.
 *
 * @example
 * ```typescript
 * // Table with .withDocument('content', ...)
 * client.documents.files.content.open(row)
 *
 * // Table without .withDocument() — TypeScript error
 * client.documents.tags // Property 'tags' does not exist
 * ```
 */
export type DocumentsHelper<
	TTableDefinitions extends TableDefinitions,
> = {
	[K in keyof TTableDefinitions as HasDocuments<
		TTableDefinitions[K]
	> extends true
		? K
		: never]: DocumentsOf<TTableDefinitions[K]>;
};

/**
 * Map of table definitions keyed by table name.
 *
 * Uses the workspace's wider `TableDefinition` (with `Record<string,
 * DocumentConfig>` document constraint) so `.withDocument()` configs
 * survive through the helpers and `DocumentsHelper` mapping.
 */
export type TableDefinitions = Record<
	string,
	// biome-ignore lint/suspicious/noExplicitAny: variance-friendly map type
	TableDefinition<any, any>
>;

// ════════════════════════════════════════════════════════════════════════════
// WORKSPACE TYPES
// ════════════════════════════════════════════════════════════════════════════

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
 * Context shared by workspace and document extension scopes.
 *
 * Used by `withExtension()`, which registers the same factory for both scopes.
 * This type is intentionally standalone (not `Pick<ExtensionContext, ...>`) because
 * workspace awareness is strongly typed (`AwarenessHelper<TDefs>`) while document
 * awareness uses a scope-specific helper. The only guarantee both scopes share is
 * a raw awareness instance (`{ raw: Awareness }`).
 *
 * If a factory needs workspace-specific fields (tables, full typed awareness, etc.),
 * use `withWorkspaceExtension()`. For document-specific fields (timeline),
 * use `withDocumentExtension()`.
 *
 * ```typescript
 * // Sync needs ydoc + raw awareness — works for both scopes:
 * .withExtension('sync', ({ ydoc, awareness, init }) => {
 *   return createProvider({ doc: ydoc, awareness: awareness.raw, waitFor: init });
 * })
 * ```
 */
export type SharedExtensionContext = {
	ydoc: Y.Doc;
	awareness: { raw: Awareness };
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
 *     whenLoaded: provider.whenSynced,
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
> = (context: ExtensionContext) => TExports & {
	init?: Promise<unknown>;
	dispose?: () => MaybePromise<void>;
	clearLocalData?: () => MaybePromise<void>;
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
	/** Typed table helpers — pure CRUD, no document management */
	tables: TablesHelper<TTableDefinitions>;
	/** Document managers — only tables with `.withDocument()` appear here */
	documents: DocumentsHelper<TTableDefinitions>;
	/** Typed KV helper */
	kv: KvHelper<TKvDefinitions>;
	/** Typed awareness helper — always present, like tables and kv */
	awareness: AwarenessHelper<TAwarenessDefinitions>;
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
	 * Yjs garbage collection for the workspace Y.Doc. Forwarded to
	 * `defineDocument` — omit to use its sync-safe default (`false`), which
	 * keeps deletion markers so peers that haven't seen the deletes yet can
	 * still reconcile. Set `true` for purely local workspaces where memory
	 * pressure matters more than sync safety.
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
	TDocExtensions extends Record<string, unknown> = Record<string, never>,
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
	 * Register an extension for BOTH the workspace Y.Doc AND all content document Y.Docs.
	 *
	 * The factory fires once for the workspace doc (at build time, synchronously) and
	 * once per content doc (at `documents.open()` time).
	 */
	withExtension<TKey extends string, TExports extends Record<string, unknown>>(
		key: TKey,
		factory: (context: SharedExtensionContext) => TExports & {
			init?: Promise<unknown>;
			dispose?: () => MaybePromise<void>;
			clearLocalData?: () => MaybePromise<void>;
		},
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions &
			Record<
				TKey,
				Extension<Omit<TExports, 'init' | 'dispose' | 'clearLocalData'>>
			>,
		TDocExtensions &
			Record<TKey, Omit<TExports, 'init' | 'dispose' | 'clearLocalData'>>,
		TActions
	>;

	/**
	 * Register an extension for the workspace Y.Doc ONLY.
	 */
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
			init?: Promise<unknown>;
			dispose?: () => MaybePromise<void>;
			clearLocalData?: () => MaybePromise<void>;
		},
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions &
			Record<
				TKey,
				Extension<Omit<TExports, 'init' | 'dispose' | 'clearLocalData'>>
			>,
		TDocExtensions,
		TActions
	>;

	/**
	 * Register a document extension that fires when content Y.Docs are opened.
	 */
	withDocumentExtension<
		K extends string,
		TDocExports extends Record<string, unknown>,
	>(
		key: K,
		factory: (
			context: DocumentContext<TDocExtensions> & {
				tableName: keyof TTableDefinitions & string;
				documentName: AllDocumentNames<TTableDefinitions>;
			},
		) =>
			| (TDocExports & {
					init?: Promise<unknown>;
					dispose?: () => MaybePromise<void>;
					clearLocalData?: () => MaybePromise<void>;
			  })
			| void,
	): WorkspaceClientBuilder<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions,
		TExtensions,
		TDocExtensions &
			Record<K, Omit<TDocExports, 'init' | 'dispose' | 'clearLocalData'>>,
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
		TDocExtensions,
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
