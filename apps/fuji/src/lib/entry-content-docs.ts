/**
 * Per-entry content Y.Doc factory with IndexedDB persistence and WebSocket
 * sync. Exports a `createEntryContentDocs(deps)` builder so the parent
 * workspace wires it with its own table + auth core — no upward import
 * back into `client.svelte.ts`. Consumers open a handle via
 * `entryContentDocs.open(entryId)`, await `whenReady` before reading, and
 * let `using` handle disposal.
 */

import type { AuthCore } from '@epicenter/auth-svelte';
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
	auth,
}: {
	workspaceId: string;
	entriesTable: Table<Entry>;
	auth: Pick<AuthCore, 'getToken'>;
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
		const body = attachRichText(ydoc);
		const idb = attachIndexedDb(ydoc);
		// Token is sourced via getToken on each connect attempt, so token
		// rotations are picked up on natural reconnects without disrupting an
		// open content-doc connection. The workspace-level client owns the
		// "force reconnect on session change" decision.
		attachSync(ydoc, {
			url: toWsUrl(`${APP_URLS.API}/docs/${ydoc.guid}`),
			waitFor: idb.whenLoaded,
			getToken: () => auth.getToken(),
		});

		onLocalUpdate(ydoc, () => {
			entriesTable.update(entryId, {
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
