/**
 * Per-note body Y.Doc builder. Pure: takes a `noteId` plus all the deps the
 * construction needs and returns a Disposable bundle. Wire into a
 * `createDisposableCache` at the workspace module scope (see
 * `client.svelte.ts`) for refcount + grace.
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
	whenReady: Promise<unknown>;
	[Symbol.dispose](): void;
};

export function createNoteBodyDoc({
	noteId,
	workspaceId,
	notesTable,
	auth,
	apiUrl,
	registerSync,
}: {
	noteId: NoteId;
	workspaceId: string;
	notesTable: Table<Note>;
	auth: Pick<AuthClient, 'snapshot' | 'whenSessionLoaded'>;
	apiUrl: string;
	registerSync: (sync: SyncAttachment) => () => void;
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
	// Token sourced from the auth snapshot on each connect attempt. The parent
	// workspace registers this handle so auth transitions reconnect open docs too.
	const sync = attachSync(ydoc, {
		url: toWsUrl(`${apiUrl}/docs/${ydoc.guid}`),
		waitFor: idb.whenLoaded,
		getToken: async () => {
			await auth.whenSessionLoaded;

			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
	});
	const unregisterSync = registerSync(sync);

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
			unregisterSync();
			ydoc.destroy();
		},
	};
}
