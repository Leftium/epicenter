/**
 * Popup-side workspace client for accessing Y.Doc data.
 *
 * The popup needs direct access to the Y.Doc for the `suspended_tabs` table,
 * which is shared across devices via Yjs (not available through Chrome APIs).
 *
 * This creates a lightweight workspace client with IndexedDB persistence
 * and Y-Sweet sync — the same Y.Doc as the background service worker.
 * Both share the same workspace ID (`tab-manager`), so IndexedDB and
 * Y-Sweet will converge on the same document.
 */

import { indexeddbPersistence } from '@epicenter/hq/extensions/persistence';
import { directAuth, ySweetSync } from '@epicenter/hq/extensions/y-sweet-sync';
import { createWorkspace, defineWorkspace } from '@epicenter/hq/static';
import { BROWSER_TABLES } from './schema';

const definition = defineWorkspace({
	id: 'tab-manager',
	tables: BROWSER_TABLES,
});

/**
 * Popup workspace client.
 *
 * Provides typed access to all browser tables including `suspended_tabs`.
 * Shares the same Y.Doc as the background service worker via IndexedDB
 * persistence and Y-Sweet sync.
 */
export const popupWorkspace = createWorkspace(definition).withExtensions({
	sync: ySweetSync({
		auth: directAuth('http://127.0.0.1:8080'),
		persistence: indexeddbPersistence,
	}),
});
