/**
 * Per-entry rich-text content document.
 *
 * Replaces the `.withDocument('content', { content: richText, guid: 'id', onUpdate })`
 * declaration on `entriesTable`. Each entry gets its own Y.Doc named
 * `epicenter.fuji.entries.${id}.content`, with rich-text content, IndexedDB
 * persistence, and WebSocket sync. Edits bump the parent row's `updatedAt`
 * via a plain closure — no framework-mediated `onUpdate` convention.
 *
 * Lifecycle is caller-owned: the editor component calls `openEntryContentDoc`
 * on mount and `doc.dispose()` on unmount. Two tabs editing the same entry
 * reconcile at the Yjs layer via IndexedDB + sync — no JS-side deduplication.
 */
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachIndexedDb,
	attachRichText,
	attachSync,
	toWsUrl,
} from '@epicenter/document';
import { DateTimeString } from '@epicenter/workspace';
import * as Y from 'yjs';
import { auth, workspace } from './client';
import type { EntryId } from './workspace';

/**
 * Opens the per-entry rich-text Y.Doc. Editor component owns the lifecycle —
 * call `dispose()` on unmount.
 *
 * `gc: false` because the doc syncs to peers: GC'd deletion markers would
 * break convergence with clients that haven't seen the deletes yet.
 */
export function openEntryContentDoc(rowId: EntryId) {
	const ydoc = new Y.Doc({
		guid: `epicenter.fuji.entries.${rowId}.content`,
		gc: false,
	});

	const content = attachRichText(ydoc);

	const idb = attachIndexedDb(ydoc);
	const sync = attachSync(ydoc, {
		url: (docId) => toWsUrl(`${APP_URLS.API}/docs/${docId}`),
		getToken: async () => auth.token,
		waitFor: idb.whenLoaded,
	});

	// Bump parent row's updatedAt on edits. Plain closure — no framework
	// `onUpdate` convention. No explicit off() needed — ydoc.destroy() clears
	// its own listeners.
	ydoc.on('update', () => {
		workspace.tables.entries.update(rowId, {
			updatedAt: DateTimeString.now(),
		});
	});

	// Expose atoms — callers compose "both" at the call site if they need it.
	// The editor only needs whenLoaded to render; sync is an enhancement.
	return {
		ydoc,
		content,
		whenLoaded: idb.whenLoaded,
		whenConnected: sync.whenConnected,
		whenDisposed: Promise.all([idb.disposed, sync.disposed]).then(() => {}),
		clearLocal: idb.clearLocal,
		reconnect: sync.reconnect,
		dispose: () => ydoc.destroy(),
	};
}

export type EntryContentDocHandle = ReturnType<typeof openEntryContentDoc>;
