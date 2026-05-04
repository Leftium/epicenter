import { clearDocument, IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';
import { lazy } from '../shared/lazy.js';

export type IndexedDbAttachment = {
	/**
	 * Resolves when local IndexedDB state has loaded into the Y.Doc: "your
	 * draft is in memory, edits are safe." Not CRDT convergence despite
	 * `y-indexeddb`'s upstream `whenSynced` name. Pair with `sync.whenConnected`
	 * when you also need remote state.
	 */
	whenLoaded: Promise<unknown>;
	clearLocal: () => Promise<void>;
	/** Destroys the IndexedDB persistence handle. */
	[Symbol.asyncDispose]: () => Promise<void>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	// `IndexeddbPersistence`'s constructor binds `doc.on('destroy', this.destroy)`
	// eagerly, and its `destroy()` has no top-level idempotency guard: two calls
	// produce two independent `_db.then(db => db.close())` promises that resolve
	// at different moments. Strip the upstream binding so our lazy()-wrapped
	// disposer is the sole gateway. Cascade-triggered teardown and explicit
	// `[Symbol.asyncDispose]()` calls then share the same memoized close promise,
	// and consumers awaiting the symbol see a barrier that doesn't lie.
	ydoc.off('destroy', idb.destroy);
	const dispose = lazy(async () => {
		await idb.destroy();
	});
	ydoc.once('destroy', () => {
		void dispose();
	});
	return {
		whenLoaded: idb.whenSynced,
		clearLocal: () => clearDocument(ydoc.guid),
		[Symbol.asyncDispose]: dispose,
	};
}
