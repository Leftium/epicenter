import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

export type IndexedDbAttachment = {
	whenSynced: Promise<IndexeddbPersistence>;
	clearLocal: () => Promise<void>;
	/**
	 * Resolves after the Y.Doc is destroyed AND IndexedDB's async teardown
	 * completes. Opt-in — most consumers don't need it, but tests and CLIs
	 * that must flush before exit can `await` this.
	 */
	disposed: Promise<void>;
};

export function attachIndexedDb(ydoc: Y.Doc): IndexedDbAttachment {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	const { promise: disposed, resolve } = Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		try {
			await idb.destroy();
		} finally {
			resolve();
		}
	});
	return {
		whenSynced: idb.whenSynced,
		clearLocal: () => idb.clearData(),
		disposed,
	};
}
