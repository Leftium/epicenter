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
	/** Destroys the IndexedDB persistence handle. */
	[Symbol.asyncDispose]: () => Promise<void>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	ydoc.off('destroy', idb.destroy);
	const dispose = lazy(async () => {
		await idb.destroy();
	});
	ydoc.once('destroy', () => {
		void dispose();
	});
	return {
		whenLoaded: idb.whenSynced.then(() => {}),
		clearLocal: () => clearDocument(ydoc.guid),
		[Symbol.asyncDispose]: dispose,
	};
}
