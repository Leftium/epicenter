/**
 * Popup-side workspace client for accessing Y.Doc data.
 *
 * The popup needs direct access to the Y.Doc for the saved tabs table,
 * which is shared across devices via Yjs (not available through Chrome APIs).
 *
 * This creates a lightweight workspace client with IndexedDB persistence
 * and Y-Sweet sync — the same Y.Doc as the background service worker.
 * Both share the same workspace ID (`tab-manager`), so IndexedDB and
 * Y-Sweet will converge on the same document.
 */

import { createSyncExtension } from '@epicenter/hq/extensions/sync';
import { indexeddbPersistence } from '@epicenter/hq/extensions/sync/web';
import { createWorkspace } from '@epicenter/hq/static';
import { definition } from '$lib/workspace';

/**
 * Popup workspace client.
 *
 * Provides typed access to all browser tables including saved tabs.
 * Shares the same Y.Doc as the background service worker via IndexedDB
 * persistence and sync.
 */
export const popupWorkspace = createWorkspace(definition).withExtension(
	'sync',
	createSyncExtension({
		url: 'ws://127.0.0.1:3913/workspaces/{id}/sync',
		persistence: indexeddbPersistence,
	}),
);
