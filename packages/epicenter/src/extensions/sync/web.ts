import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

/**
 * IndexedDB persistence for a Yjs document.
 *
 * Stores the document in the browser's IndexedDB using `ydoc.guid` as the
 * database name. Loads existing state on creation and auto-saves on every
 * Yjs update (both handled internally by `y-indexeddb`).
 *
 * Works directly as an extension factory — destructures `ydoc` from the
 * workspace client context. Chain before sync so `context.whenReady`
 * includes persistence readiness.
 *
 * @example Persistence + sync (recommended pattern)
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/hq/extensions/sync/web';
 * import { createSyncExtension } from '@epicenter/hq/extensions/sync';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: 'ws://localhost:3913/workspaces/{id}/sync',
 *   }))
 * ```
 *
 * @example Standalone persistence (no sync)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 * ```
 */
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	return {
		exports: {
			clearData: () => idb.clearData(),
		},
		// y-indexeddb's whenSynced = "data loaded from IndexedDB"
		whenReady: idb.whenSynced,
		destroy: () => idb.destroy(),
	};
}
