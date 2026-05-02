/**
 * Per-entry content Y.Doc builder. Pure: takes an `entryId` plus all the
 * deps the construction needs and returns a Disposable bundle. Browser
 * clients open these through `createBrowserDocumentFamily` for caching and
 * active sync control.
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
import type { Entry, EntryId } from '$lib/workspace';

export type EntryContentDoc = {
	ydoc: Y.Doc;
	body: ReturnType<typeof attachRichText>;
	idb: ReturnType<typeof attachIndexedDb>;
	sync: SyncAttachment;
	whenLoaded: Promise<unknown>;
	[Symbol.dispose](): void;
};

export function entryContentDocGuid({
	workspaceId,
	entryId,
}: {
	workspaceId: string;
	entryId: EntryId;
}): string {
	return docGuid({
		workspaceId,
		collection: 'entries',
		rowId: entryId,
		field: 'content',
	});
}

export function createEntryContentDoc({
	entryId,
	workspaceId,
	entriesTable,
	auth,
	apiUrl,
}: {
	entryId: EntryId;
	workspaceId: string;
	entriesTable: Table<Entry>;
	auth: Pick<AuthClient, 'snapshot' | 'whenLoaded'>;
	apiUrl: string;
}): EntryContentDoc {
	const ydoc = new Y.Doc({
		guid: entryContentDocGuid({ workspaceId, entryId }),
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
		entriesTable.update(entryId, {
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
