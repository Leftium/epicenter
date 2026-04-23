/**
 * Per-note body Y.Doc factory with IndexedDB persistence and WebSocket sync.
 * Exports a `createNoteBodyDocs(deps)` builder so the parent workspace wires
 * it with its own table + auth core — no upward import back into
 * `client.svelte.ts`. Consumers open a handle via `noteBodyDocs.open(noteId)`,
 * await `whenReady` before reading, and let `using` handle disposal.
 */

import type { AuthCore } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachIndexedDb,
	attachRichText,
	attachSync,
	createDocumentFactory,
	DateTimeString,
	docGuid,
	onLocalUpdate,
	type Table,
	toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Note, NoteId } from '$lib/workspace';

export function createNoteBodyDocs({
	workspaceId,
	notesTable,
	auth,
}: {
	workspaceId: string;
	notesTable: Table<Note>;
	auth: Pick<AuthCore, 'getToken' | 'onTokenChange'>;
}) {
	return createDocumentFactory((noteId: NoteId) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId,
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
		sync.setToken(auth.getToken());
		const unsubscribeToken = auth.onTokenChange((token) => {
			sync.setToken(token);
		});

		onLocalUpdate(ydoc, () => {
			notesTable.update(noteId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc,
			body,
			whenReady: idb.whenLoaded,
			[Symbol.dispose]() {
				unsubscribeToken();
				ydoc.destroy();
			},
		};
	});
}
