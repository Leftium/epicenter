/**
 * Entry content document — per-entry Y.Doc with IndexedDB persistence.
 *
 * Apps own content-doc construction directly. The `buildEntryContentDoc`
 * closure produces the Y.Doc bundle; `entryContentDocs` is the cached factory
 * returned by `defineDocument`.
 *
 * Consumers open a handle via `entryContentDocs.open(entryId)`, await
 * `handle.whenReady` before reading, and let `using` handle disposal.
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
import type { EntryId } from '$lib/workspace';

function buildEntryContentDoc(entryId: EntryId) {
	const ydoc = new Y.Doc({
		guid: docGuid({
			workspaceId: workspace.id,
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
		getToken: async () => auth.token,
		waitFor: idb.whenLoaded,
	});

	onLocalUpdate(ydoc, () => {
		workspace.tables.entries.update(entryId, {
			updatedAt: DateTimeString.now(),
		});
	});

	return {
		ydoc,
		content,
		idb,
		sync,
		whenReady: idb.whenLoaded,
		whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(
			() => {},
		),
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export const entryContentDocs = defineDocument(buildEntryContentDoc, {
	gcTime: 30_000,
});
