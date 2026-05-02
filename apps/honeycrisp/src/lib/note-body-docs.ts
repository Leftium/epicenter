/**
 * Per-note body Y.Doc builder. Pure: takes a `noteId` plus all the deps the
 * construction needs and returns a Disposable bundle. Browser clients open
 * these through `createBrowserDocumentCollection` for caching, active sync
 * control, and local store cleanup.
 */

import type { AuthClient } from '@epicenter/auth-svelte';
import {
	attachIndexedDb,
	attachRichText,
	attachSync,
	DateTimeString,
	docGuid,
	onLocalUpdate,
	type SyncAttachment,
	type Table,
	toWsUrl,
} from '@epicenter/workspace';
import * as Y from 'yjs';
import type { Note, NoteId } from '$lib/workspace';

export type NoteBodyDoc = {
	ydoc: Y.Doc;
	body: ReturnType<typeof attachRichText>;
	idb: ReturnType<typeof attachIndexedDb>;
	sync: SyncAttachment;
	whenLoaded: Promise<unknown>;
	[Symbol.dispose](): void;
};

export function createNoteBodyDoc({
	noteId,
	workspaceId,
	notesTable,
	auth,
	apiUrl,
}: {
	noteId: NoteId;
	workspaceId: string;
	notesTable: Table<Note>;
	auth: Pick<AuthClient, 'snapshot' | 'whenLoaded'>;
	apiUrl: string;
}): NoteBodyDoc {
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
		url: toWsUrl(`${apiUrl}/docs/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
		getToken: async () => {
			await auth.whenLoaded;

			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
	});

	onLocalUpdate(ydoc, () => {
		notesTable.update(noteId, {
			updatedAt: DateTimeString.now(),
		});
	});

	return {
		ydoc,
		body,
		idb,
		sync,
		whenLoaded: idb.whenLoaded,
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}
