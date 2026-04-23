/**
 * Per-note body Y.Doc factory with IndexedDB persistence and WebSocket sync.
 * Exports a `createNoteBodyDocs(deps)` builder so the parent workspace wires
 * it with its own table + token source — no upward import back into
 * `client.svelte.ts`. Consumers open a handle via `noteBodyDocs.open(noteId)`,
 * await `whenReady` before reading, and let `using` handle disposal.
 */

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
	getToken,
}: {
	workspaceId: string;
	notesTable: Table<Note>;
	getToken: () => string | null;
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
		// Seed with the current token; per-doc sync doesn't observe token rotation.
		// On editor re-open the next handle picks up any refreshed token.
		sync.setToken(getToken());

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
				ydoc.destroy();
			},
		};
	});
}
