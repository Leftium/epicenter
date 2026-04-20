/**
 * Per-entry rich-text content document.
 *
 * Each entry gets its own Y.Doc named `epicenter.fuji.entries.${id}.content`,
 * with rich-text content, IndexedDB persistence, and WebSocket sync. Edits
 * bump the parent row's `updatedAt` via a plain closure.
 *
 * Lifecycle is caller-owned: the editor calls `openEntryContentDoc` on mount
 * and `ydoc.destroy()` on unmount. Two tabs editing the same entry reconcile
 * at the Yjs layer (IndexedDB + sync). No JS-side deduplication.
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
 * Opens the per-entry rich-text Y.Doc.
 *
 * `gc: false` because the doc syncs: GC'd deletion markers break convergence
 * with peers that haven't seen the deletes.
 */
export function openEntryContentDoc(rowId: EntryId) {
	const ydoc = new Y.Doc({
		guid: `epicenter.fuji.entries.${rowId}.content`,
		gc: false,
	});

	const content = attachRichText(ydoc);
	const { whenLoaded } = attachIndexedDb(ydoc);
	attachSync(ydoc, {
		url: (docId) => toWsUrl(`${APP_URLS.API}/docs/${docId}`),
		getToken: async () => auth.token,
		waitFor: whenLoaded,
	});

	// Bump parent row on edits. No explicit off() — ydoc.destroy() clears listeners.
	ydoc.on('update', () => {
		workspace.tables.entries.update(rowId, {
			updatedAt: DateTimeString.now(),
		});
	});

	return { ydoc, content, whenLoaded };
}

export type EntryContentDocHandle = ReturnType<typeof openEntryContentDoc>;
