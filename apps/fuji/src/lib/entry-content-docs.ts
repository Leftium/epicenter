/**
 * Per-entry content Y.Doc factory with IndexedDB persistence and WebSocket
 * sync. Exports a `createEntryContentDocs(deps)` builder so the parent
 * workspace wires it with its own table + token source — no upward import
 * back into `client.svelte.ts`. Consumers open a handle via
 * `entryContentDocs.open(entryId)`, await `whenReady` before reading, and
 * let `using` handle disposal.
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
import type { Entry, EntryId } from '$lib/workspace';

export function createEntryContentDocs({
	workspaceId,
	entriesTable,
	getToken,
}: {
	workspaceId: string;
	entriesTable: Table<Entry>;
	getToken: () => string | null;
}) {
	return createDocumentFactory((entryId: EntryId) => {
		const ydoc = new Y.Doc({
			guid: docGuid({
				workspaceId,
				collection: 'entries',
				rowId: entryId,
				field: 'content',
			}),
			gc: false,
		});
		const content = attachRichText(ydoc);
		const idb = attachIndexedDb(ydoc);
		const sync = attachSync(ydoc, {
			url: (docId) => toWsUrl(`${APP_URLS.API}/docs/${docId}`),
			waitFor: idb.whenLoaded,
		});
		// Seed with the current token; per-doc sync doesn't observe token rotation.
		// On editor re-open the next handle picks up any refreshed token.
		sync.setToken(getToken());

		onLocalUpdate(ydoc, () => {
			entriesTable.update(entryId, {
				updatedAt: DateTimeString.now(),
			});
		});

		return {
			ydoc,
			content,
			idb,
			sync,
			whenReady: idb.whenLoaded,
			[Symbol.dispose]() {
				ydoc.destroy();
			},
		};
	});
}
