/**
 * `defineWorkspace` — sugar over `defineDocument` + `attachTables` +
 * `attachKv` + `attachAwareness` + `attachEncryption` for the common case:
 * a schema-only workspace with the default bundle shape.
 *
 * The body of this function is literally the five-line attach sequence
 * wrapped in a `defineDocument` closure. There is no hidden logic — it's a
 * typed convenience that saves ~15 lines of ceremony for workspaces that
 * don't need custom bundle fields.
 *
 * ## When to use which
 *
 * - **Use `defineWorkspace`** when you want the default bundle (tables, kv,
 *   awareness, enc, batch, whenReady, whenDisposed, Symbol.dispose) and
 *   nothing else. Typical callers: tests, benchmarks, importer targets,
 *   demos, small in-memory workspaces.
 *
 * - **Use `defineDocument` + primitives directly** when you need to compose
 *   app-specific attachments into the bundle — sync, indexedDB, actions,
 *   filesystem helpers, shell emulators, etc. All the real apps in this
 *   monorepo do this; see any `apps/<app>/src/lib/client.ts`.
 *
 * The two tools have non-overlapping use cases. Sugar pays off when the
 * default shape fits; primitives pay off when you need custom fields in
 * the handle.
 *
 * ## Return shape
 *
 * A `WorkspaceFactory<Id, Bundle>` — a `DocumentFactory` with the workspace
 * `definition` attached as metadata (so the `createWorkspace` extension
 * builder can read tables/kv/awareness defs back out). Apps call `.open(id)`
 * to get a `WorkspaceHandle` that prototype-chains to the bundle and has
 * `dispose()` / `[Symbol.dispose]()` for explicit teardown.
 *
 * ## `gcTime: Infinity`
 *
 * Workspaces aren't cheap to reconstruct — re-attaching IndexedDB and sync
 * after a grace window evicts the bundle means hammering the server on every
 * remount. The default is `Infinity`: refcount→0 doesn't auto-evict. Callers
 * who want idle teardown pass a finite `gcTime`; `factory.close(id)` still
 * forces teardown on demand.
 *
 * ## Bundle shape
 *
 * ```text
 *   ydoc         : Y.Doc                       (guid = id)
 *   tables       : Tables<T>                   (per-table helpers)
 *   kv           : Kv<T>                       (typed KV helper)
 *   awareness    : Awareness<T>                (typed awareness helper)
 *   enc          : EncryptionAttachment        (applyKeys, stores, whenDisposed)
 *   batch(fn)    : void                        (ydoc.transact sugar)
 *   whenReady    : Promise<void>               (resolved immediately — apps compose)
 *   whenDisposed : Promise<void>               (resolves when every encrypted store is disposed)
 *   [Symbol.dispose] : () => void              (destroys ydoc, cascades to every provider)
 * ```
 *
 * Persistence and sync are NOT in the bundle — if you need them, drop to
 * `defineDocument` and compose directly. Trying to wrap `defineWorkspace`
 * output with additional fields usually ends up more awkward than just
 * writing the primitive sequence explicitly.
 *
 * @example
 * ```ts
 * // Schema-only workspace (no persistence, no sync) — sugar earns its keep.
 * export const redditWorkspace = defineWorkspace({
 *   id: 'reddit-ingest',
 *   tables: redditTables,
 *   kv: redditKv,
 * });
 *
 * using ws = redditWorkspace.open('reddit-ingest');
 * ws.tables.posts.set({ id: 'abc', ... });
 * ```
 *
 * @example
 * ```ts
 * // If you need custom bundle fields, use defineDocument instead:
 * const factory = defineDocument((id) => {
 *   const ydoc = new Y.Doc({ guid: id, gc: false });
 *   const tables = attachTables(ydoc, myTables);
 *   const kv = attachKv(ydoc, myKv);
 *   const enc = attachEncryption(ydoc, { tables, kv });
 *   const idb = attachIndexedDb(ydoc);
 *   const sync = attachSync(ydoc, { url, getToken, waitFor: idb.whenLoaded });
 *   return { id, ydoc, tables: tables.helpers, kv: kv.helper, enc, idb, sync, ... };
 * });
 * ```
 *
 * @module
 */

import { attachAwareness, defineDocument } from '@epicenter/document';
import type { DocumentFactory, DocumentHandle } from '@epicenter/document';
import * as Y from 'yjs';
import {
	attachEncryption,
	type EncryptionAttachment,
} from '../shared/attach-encryption.js';
import { attachEncryptedKv } from './attach-kv.js';
import { attachEncryptedTables } from './attach-tables.js';
import type {
	Awareness,
	AwarenessDefinitions,
	Kv,
	KvDefinitions,
	TableDefinitions,
	Tables,
	WorkspaceDefinition,
} from './types.js';

export type WorkspaceBundle<
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
> = {
	ydoc: Y.Doc;
	tables: Tables<TTableDefinitions>;
	kv: Kv<TKvDefinitions>;
	awareness: Awareness<TAwarenessDefinitions>;
	encryption: EncryptionAttachment;
	/** Sugar for `ydoc.transact(fn)`. Coalesces a sequence of mutations into one Yjs transaction. */
	batch(fn: () => void): void;
	whenReady: Promise<void>;
	whenDisposed: Promise<void>;
	[Symbol.dispose](): void;
};

export type WorkspaceHandle<
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
> = DocumentHandle<
	WorkspaceBundle<TTableDefinitions, TKvDefinitions, TAwarenessDefinitions>
>;

export type WorkspaceFactory<
	TId extends string,
	TTableDefinitions extends TableDefinitions,
	TKvDefinitions extends KvDefinitions,
	TAwarenessDefinitions extends AwarenessDefinitions,
> = DocumentFactory<
	TId,
	WorkspaceBundle<TTableDefinitions, TKvDefinitions, TAwarenessDefinitions>
> & {
	/**
	 * The original schema the factory was built from. Read by the transitional
	 * `createWorkspace` shim to wire its legacy surface; consumers of the
	 * factory directly do not need to read this.
	 */
	readonly definition: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions
	>;
};

/**
 * Define a workspace schema. Returns a factory whose `.open(id)` constructs
 * the workspace bundle on first access and returns a refcounted handle on
 * subsequent calls. Multiple `.open(id)` handles share one Y.Doc.
 */
export function defineWorkspace<
	TId extends string,
	TTableDefinitions extends TableDefinitions = Record<string, never>,
	TKvDefinitions extends KvDefinitions = Record<string, never>,
	TAwarenessDefinitions extends AwarenessDefinitions = Record<string, never>,
>(
	{
		id,
		tables: tableDefs = {} as TTableDefinitions,
		kv: kvDefs = {} as TKvDefinitions,
		awareness: awarenessDefs = {} as TAwarenessDefinitions,
		// gc defaults to false — deletion-marker GC breaks sync with peers that
		// haven't seen the deletes yet. Opt in only for purely local docs.
		gc = false,
	}: {
		id: TId;
		tables?: TTableDefinitions;
		kv?: TKvDefinitions;
		awareness?: TAwarenessDefinitions;
		gc?: boolean;
	},
	{ gcTime = Infinity }: { gcTime?: number } = {},
): WorkspaceFactory<
	TId,
	TTableDefinitions,
	TKvDefinitions,
	TAwarenessDefinitions
> {
	const definition: WorkspaceDefinition<
		TId,
		TTableDefinitions,
		TKvDefinitions,
		TAwarenessDefinitions
	> = { id, tables: tableDefs, kv: kvDefs, awareness: awarenessDefs, gc };

	const factory = defineDocument<
		TId,
		WorkspaceBundle<TTableDefinitions, TKvDefinitions, TAwarenessDefinitions>
	>(
		(id) => {
			const ydoc = new Y.Doc({ guid: id, gc });
			const encryption = attachEncryption(ydoc);
			const tables = attachEncryptedTables(ydoc, encryption, tableDefs);
			const kv = attachEncryptedKv(ydoc, encryption, kvDefs);
			const awareness = attachAwareness(ydoc, awarenessDefs);

			return {
				ydoc,
				tables,
				kv,
				awareness,
				encryption,
				batch(fn: () => void): void {
					ydoc.transact(fn);
				},
				// Base bundle is always ready — apps that compose attachments on
				// top aggregate their own whenReady. Consumers awaiting only the
				// base see an already-resolved promise.
				whenReady: Promise.resolve(),
				whenDisposed: encryption.whenDisposed,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime },
	);

	return Object.assign(factory, { definition });
}
