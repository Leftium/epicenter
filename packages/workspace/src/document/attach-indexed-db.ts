/// <reference lib="dom" />

import { clearDocument, IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

export function attachIndexedDb(
	ydoc: Y.Doc,
	options: { databaseName?: string } = {},
) {
	const databaseName = options.databaseName ?? ydoc.guid;
	// Corrupt-store healing lives in `patches/y-indexeddb@9.0.12.patch`, not here.
	// The upstream loader applies persisted updates with no `.catch`, so a single
	// undecodable update both wedges `whenSynced` forever and floats an uncatchable
	// decode error. The patch wraps the per-update apply in a `try/catch` that skips
	// the bad bytes (server resync supplies them) and still emits `'synced'`.
	// `attach-local-storage-corrupt-load.test.ts` is the regression gate: it goes
	// red the day the patch stops applying.
	const idb = new IndexeddbPersistence(databaseName, ydoc);
	// `IndexeddbPersistence`'s constructor binds `doc.on('destroy', this.destroy)`
	// eagerly, and its `destroy()` has no top-level idempotency guard: two calls
	// produce two independent `_db.then(db => db.close())` promises that resolve
	// at different moments. Strip the upstream binding so our wrapper is the
	// sole gateway. Cascade-triggered teardown resolves `whenDisposed` only
	// after the actual close completes, so wipe() can await an honest barrier.
	ydoc.off('destroy', idb.destroy);
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	const whenLoaded: Promise<unknown> = idb.whenSynced;
	const clearLocal = (): Promise<void> => clearDocument(databaseName);
	ydoc.once('destroy', async () => {
		try {
			await idb.destroy();
		} finally {
			resolveDisposed();
		}
	});
	return {
		/**
		 * Resolves when local IndexedDB state has loaded into the Y.Doc: "your
		 * draft is in memory, edits are safe." Not CRDT convergence despite
		 * `y-indexeddb`'s upstream `whenSynced` name. Pair with `sync.whenConnected`
		 * when you also need remote state. The patched loader skips undecodable
		 * updates rather than hanging, so this never wedges on a corrupt store.
		 */
		whenLoaded,
		/** Delete the local IndexedDB document without destroying the Y.Doc. */
		clearLocal,
		/**
		 * Resolves after `ydoc.destroy()` fires the cascade and the IndexedDB
		 * connection has actually closed. Bundle wipe methods await this before
		 * deleting persisted data.
		 */
		whenDisposed,
	};
}

export type IndexedDbAttachment = ReturnType<typeof attachIndexedDb>;
