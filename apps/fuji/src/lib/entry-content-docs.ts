/**
 * Per-entry content Y.Doc builder. Pure: takes an `entryId` plus all the
 * deps the construction needs and returns a Disposable bundle. Wire into a
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
import type { Entry, EntryId } from '$lib/workspace';

export type EntryContentDoc = {
	ydoc: Y.Doc;
	body: ReturnType<typeof attachRichText>;
	sync: SyncAttachment;
	whenReady: Promise<unknown>;
	[Symbol.dispose](): void;
};

export function createEntryContentDoc({
	entryId,
	workspaceId,
	entriesTable,
	auth,
	apiUrl,
	registerSync,
}: {
	entryId: EntryId;
	workspaceId: string;
	entriesTable: Table<Entry>;
	auth: Pick<AuthClient, 'snapshot' | 'whenSessionLoaded'>;
	apiUrl: string;
	registerSync?: (sync: SyncAttachment) => () => void;
}): EntryContentDoc {
	const ydoc = new Y.Doc({
		guid: docGuid({
			workspaceId,
			collection: 'entries',
			rowId: entryId,
			field: 'content',
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
	const unregisterSync = registerSync?.(sync);

	onLocalUpdate(ydoc, () => {
		entriesTable.update(entryId, {
			updatedAt: DateTimeString.now(),
		});
	});

	return {
		ydoc,
		body,
		sync,
		whenReady: idb.whenLoaded,
		[Symbol.dispose]() {
			unregisterSync?.();
			ydoc.destroy();
		},
	};
}
