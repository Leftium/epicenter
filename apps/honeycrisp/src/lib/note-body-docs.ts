/**
 * Per-note body Y.Doc factory with IndexedDB persistence and WebSocket sync.
 * Consumers open a handle via `noteBodyDocs.open(noteId)`, await `whenReady`
 * before reading, and let `using` handle disposal.
 */

import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachIndexedDb,
	attachRichText,
	attachSync,
	defineDocument,
	docGuid,
	onLocalUpdate,
	toWsUrl,
} from '@epicenter/document';
import { DateTimeString } from '@epicenter/workspace';
import * as Y from 'yjs';
import { auth, workspace } from '$lib/client';
import type { NoteId } from '$lib/workspace';

export const noteBodyDocs = defineDocument((noteId: NoteId) => {
	const ydoc = new Y.Doc({
		guid: docGuid({
			workspaceId: workspace.id,
			collection: 'notes',
			rowId: noteId,
			field: 'body',
		}),
		gc: false,
	});
	const body = attachRichText(ydoc);
	const idb = attachIndexedDb(ydoc);
	const sync = attachSync(ydoc, {
		url: (docId) => toWsUrl(`${APP_URLS.API}/docs/${docId}`),
		getToken: async () => auth.token,
		waitFor: idb.whenLoaded,
	});

	onLocalUpdate(ydoc, () => {
		workspace.tables.notes.update(noteId, {
			updatedAt: DateTimeString.now(),
		});
	});

	return {
		ydoc,
		body,
		whenReady: idb.whenLoaded,
		whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(
			() => {},
		),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});
