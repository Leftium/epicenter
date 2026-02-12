import { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';
import { defineExports } from '../../dynamic/extension';

/**
 * IndexedDB persistence for a Yjs document.
 *
 * Stores the document in the browser's IndexedDB using `ydoc.guid` as the
 * database name. Loads existing state on creation and auto-saves on every
 * Yjs update (both handled internally by `y-indexeddb`).
 *
 * Works directly as an extension factory (destructures `ydoc` from context)
 * and as a persistence option for `ySweetSync`.
 *
 * @example As a workspace extension
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/hq/extensions/persistence/web';
 *
 * const workspace = createWorkspace({ name: 'Blog', tables: {...} })
 *   .withExtensions({ persistence: indexeddbPersistence });
 * ```
 *
 * @example With Y-Sweet sync
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/hq/extensions/persistence/web';
 *
 * sync: ySweetSync({
 *   auth: directAuth('http://localhost:8080'),
 *   persistence: indexeddbPersistence,
 * })
 * ```
 */
export function indexeddbPersistence({ ydoc }: { ydoc: Y.Doc }) {
	const idb = new IndexeddbPersistence(ydoc.guid, ydoc);
	return defineExports({
		whenSynced: idb.whenSynced,
		destroy: () => idb.destroy(),
		clearData: () => idb.clearData(),
	});
}
