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
	createDocumentFactory,
	docGuid,
	onLocalUpdate,
	toWsUrl,
} from '@epicenter/workspace';
import { DateTimeString } from '@epicenter/workspace';
import * as Y from 'yjs';
import { auth, workspace } from '$lib/client.svelte';
import type { NoteId } from '$lib/workspace';

export const noteBodyDocs = createDocumentFactory((noteId: NoteId) => {
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
		waitFor: idb.whenLoaded,
	});
	// Seed with the current token; per-doc sync doesn't observe token rotation.
	// On editor re-open the next handle picks up any refreshed token.
	sync.setToken(auth.token);

	onLocalUpdate(ydoc, () => {
		workspace.tables.notes.update(noteId, {
			updatedAt: DateTimeString.now(),
		});
	});

	return {
		ydoc,
		body,
		idb,
		sync,
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
});
