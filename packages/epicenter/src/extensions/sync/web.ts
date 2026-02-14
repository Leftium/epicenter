import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';
import { defineExtension } from '../../shared/lifecycle';

/**
 * IndexedDB persistence for a Yjs document.
 *
 * Stores the document in the browser's IndexedDB using `ydoc.guid` as the
 * database name. Loads existing state on creation and auto-saves on every
 * Yjs update (both handled internally by `y-indexeddb`).
 *
 * Works directly as an extension factory (destructures `ydoc` from context)
 * and as a persistence option for `createSyncExtension`.
 *
 * @example As a workspace extension
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/hq/extensions/sync/web';
 *
 * const workspace = createWorkspace({ name: 'Blog', tables: {...} })
 *   .withExtension('persistence', () => indexeddbPersistence);
 * ```
 *
 * @example With sync extension
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/hq/extensions/sync/web';
 *
 * .withExtension('sync', () => createSyncExtension({
 *   url: 'ws://localhost:3913/workspaces/{id}/sync',
 *   persistence: indexeddbPersistence,
 * }))
 * ```
 */
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	return defineExtension({
		exports: {
			clearData: () => idb.clearData(),
		},
		// y-indexeddb's whenSynced = "data loaded from IndexedDB"
		whenReady: idb.whenSynced,
		destroy: () => idb.destroy(),
	});
}
