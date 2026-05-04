import { IndexeddbPersistence, clearDocument } from 'y-indexeddb';
import type * as Y from 'yjs';
import { lazy } from '../shared/lazy.js';

export type IndexedDbAttachment = {
	/**
	 * Resolves when local IndexedDB state has loaded into the Y.Doc — "your
	 * draft is in memory, edits are safe." Not CRDT convergence despite
	 * `y-indexeddb`'s upstream `whenSynced` name. Pair with `sync.whenConnected`
	 * when you also need remote state.
	 */
	whenLoaded: Promise<unknown>;
	clearLocal: () => Promise<void>;
	/**
	 * Resolves after the Y.Doc is destroyed AND IndexedDB's async teardown
	 * completes. Opt-in — tests and CLIs flushing before exit await this.
	 * Named symmetrically with `whenLoaded` — both are promises.
	 *
	 * @deprecated Use `[Symbol.asyncDispose]()` instead.
	 */
	whenDisposed: Promise<unknown>;
	[Symbol.asyncDispose]: () => Promise<void>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	ydoc.off('destroy', idb.destroy);
	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	const dispose = lazy(async () => {
		try {
			await idb.destroy();
		} finally {
			resolveDisposed();
		}
	});
	ydoc.once('destroy', () => {
		void dispose();
	});
	return {
		whenLoaded: idb.whenSynced.then(() => {}),
		clearLocal: () => clearDocument(ydoc.guid),
		whenDisposed,
		[Symbol.asyncDispose]: dispose,
	};
}
