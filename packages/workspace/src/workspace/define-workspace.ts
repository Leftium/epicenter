/**
 * `defineWorkspace` — declare a workspace schema and get a factory-of-factories
 * that constructs the workspace Y.Doc on demand, cached by id through the same
 * refcounted machinery that content docs use (`defineDocument`).
 *
 * ## Return shape
 *
 * A `WorkspaceFactory<Id, Bundle>` — a `DocumentFactory` with the workspace
 * `definition` attached as metadata (so the transitional `createWorkspace`
 * shim can read tables/kv/awareness defs back out for its legacy surface).
 * Apps call `.open(id)` to get a `WorkspaceHandle` that prototype-chains to
 * the bundle and has `dispose()` / `[Symbol.dispose]()` for explicit teardown.
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
 * Persistence and sync are NOT in the bundle — they're user-owned composition
 * on top. An app wraps `defineWorkspace(def).open(id)` with its own helper
 * that attaches IndexedDB / WebSocket / SQLite index, aggregates their ready
 * promises into a composite `whenReady`, and layers actions on top.
 *
 * @example
 * ```ts
 * const fujiWorkspaces = defineWorkspace({ id: 'epicenter.fuji', tables: { entries } });
 *
 * export function createFujiWorkspace() {
 *   const base = fujiWorkspaces.open('epicenter.fuji');
 *   const idb  = attachIndexedDb(base.ydoc);
 *   const sync = attachSync(base.ydoc, { url, getToken, waitFor: idb.whenLoaded });
 *   return Object.assign(base, {
 *     idb, sync,
 *     whenReady: Promise.all([idb.whenLoaded, sync.whenConnected]).then(() => {}),
 *   });
 * }
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
import { attachKv } from './attach-kv.js';
import { attachTables } from './attach-tables.js';
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
	enc: EncryptionAttachment;
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
	config: {
		id: TId;
		tables?: TTableDefinitions;
		kv?: TKvDefinitions;
		awareness?: TAwarenessDefinitions;
		gc?: boolean;
	},
	opts?: { gcTime?: number },
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
	> = {
		id: config.id,
		tables: (config.tables ?? {}) as TTableDefinitions,
		kv: (config.kv ?? {}) as TKvDefinitions,
		awareness: config.awareness,
		gc: config.gc,
	};

	const factory = defineDocument<
		TId,
		WorkspaceBundle<TTableDefinitions, TKvDefinitions, TAwarenessDefinitions>
	>(
		(id) => {
			// gc defaults to false — deletion-marker GC breaks sync with peers
			// that haven't seen the deletes yet. Per-workspace opt-in for purely
			// local docs where memory matters more than sync safety.
			const ydoc = new Y.Doc({ guid: id, gc: definition.gc ?? false });
			const tables = attachTables(
				ydoc,
				(definition.tables ?? {}) as TTableDefinitions,
			);
			const kv = attachKv(
				ydoc,
				(definition.kv ?? {}) as TKvDefinitions,
			);
			const awareness = attachAwareness(
				ydoc,
				(definition.awareness ?? {}) as TAwarenessDefinitions,
			);
			const enc = attachEncryption(ydoc, {
				stores: [...tables.stores, kv.store],
			});

			return {
				ydoc,
				tables: tables.helpers,
				kv: kv.helper,
				awareness,
				enc,
				batch(fn: () => void): void {
					ydoc.transact(fn);
				},
				// Base bundle is always ready — apps that compose attachments on
				// top aggregate their own whenReady. Consumers awaiting only the
				// base see an already-resolved promise.
				whenReady: Promise.resolve(),
				whenDisposed: enc.whenDisposed,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		},
		{ gcTime: opts?.gcTime ?? Infinity },
	);

	return Object.assign(factory, { definition });
}
