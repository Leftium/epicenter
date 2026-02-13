/**
 * Popup-side workspace client for accessing Y.Doc data.
 *
 * The popup needs direct access to the Y.Doc for the `suspendedTabs` table,
 * which is shared across devices via Yjs (not available through Chrome APIs).
 *
 * This creates a lightweight workspace client with IndexedDB persistence
 * and Y-Sweet sync — the same Y.Doc as the background service worker.
 * Both share the same workspace ID (`tab-manager`), so IndexedDB and
 * Y-Sweet will converge on the same document.
 */

import {
	directAuth,
	ySweetPersistSync,
} from '@epicenter/hq/extensions/y-sweet-persist-sync';
import { indexeddbPersistence } from '@epicenter/hq/extensions/y-sweet-persist-sync/web';
import { createWorkspace } from '@epicenter/hq/static';
import { definition } from '$lib/workspace';

/**
 * Popup workspace client.
 *
 * Provides typed access to all browser tables including `suspendedTabs`.
 * Shares the same Y.Doc as the background service worker via IndexedDB
 * persistence and Y-Sweet sync.
 */
export const popupWorkspace = createWorkspace(definition).withExtension(
	'sync',
	ySweetPersistSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
);
