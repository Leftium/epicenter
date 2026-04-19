/**
 * Per-entry rich-text content document, built on `@epicenter/yjs-doc`.
 *
 * Replaces the `.withDocument('content', { content: richText, guid: 'id', onUpdate })`
 * declaration on `entriesTable`. Each entry gets its own Y.Doc named
 * `epicenter.fuji.entries.${id}.content`, with rich-text content, IndexedDB
 * persistence, and WebSocket sync. Edits bump the parent row's `updatedAt`
 * via a plain closure — no framework-mediated `onUpdate` convention.
 *
 * Lifecycle is caller-owned: the editor component calls `openDocument` on
 * mount and `dispose()` on unmount. Two tabs editing the same entry reconcile
 * at the Yjs layer via IndexedDB + sync — no JS-side deduplication.
 */
import { APP_URLS } from '@epicenter/constants/vite';
import { DateTimeString } from '@epicenter/workspace';
import {
	attachIndexedDb,
	attachRichText,
	attachSync,
	defineDocument,
	openDocument,
	toWsUrl,
} from '@epicenter/yjs-doc';
import { auth, workspace } from './client';
import type { EntryId } from './workspace';

/** Opens the per-entry rich-text Y.Doc. Editor component owns lifecycle. */
export function openEntryContentDoc(rowId: EntryId) {
	return openDocument(entryContentDoc(rowId));
}

export type EntryContentDocHandle = ReturnType<typeof openEntryContentDoc>;

function entryContentDoc(rowId: EntryId) {
	return defineDocument(
		`epicenter.fuji.entries.${rowId}.content`,
		(ydoc) => {
			const content = attachRichText(ydoc);

			const idb = attachIndexedDb(ydoc);
			const sync = attachSync(ydoc, {
				url: (docId) => toWsUrl(`${APP_URLS.API}/docs/${docId}`),
				getToken: async () => auth.token,
				waitFor: idb.whenLoaded,
			});

			const bumpUpdatedAt = () => {
				workspace.tables.entries.update(rowId, {
					updatedAt: DateTimeString.now(),
				});
			};
			ydoc.on('update', bumpUpdatedAt);
			// No explicit off() needed — ydoc.destroy() clears its own listeners.

			// Expose atoms — callers compose "both" at the call site if they need it.
			// The editor only needs whenLoaded to render; sync is an enhancement.
			return {
				content,
				whenLoaded: idb.whenLoaded,
				whenConnected: sync.whenConnected,
				whenDisposed: Promise.all([idb.disposed, sync.disposed]).then(() => {}),
				clearLocal: idb.clearLocal,
				reconnect: sync.reconnect,
			};
		},
	);
}
