import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	createDisposableCache,
	type PeerDescriptor,
	toWsUrl,
} from '@epicenter/workspace';
import { createEntryContentDoc } from '$lib/entry-content-docs';
import type { EntryId } from '$lib/workspace';
import { openFuji as openFujiDoc } from './index';

export function openFuji({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerDescriptor;
}) {
	const doc = openFujiDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const entryContentDocs = createDisposableCache(
		(entryId: EntryId) =>
			createEntryContentDoc({
				entryId,
				workspaceId: doc.ydoc.guid,
				entriesTable: doc.tables.entries,
				auth,
				apiUrl: APP_URLS.API,
			}),
		{ gcTime: 5_000 },
	);

	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		getToken: async () => auth.getToken(),
	});
	const presence = sync.attachPresence({ peer });
	const rpc = sync.attachRpc(doc.actions);

	return {
		...doc,
		idb,
		entryContentDocs,
		sync,
		presence,
		rpc,
		/**
		 * Resolves when IndexedDB has hydrated the local snapshot. The UI can
		 * render with persisted data. Does NOT gate sync (the WebSocket can
		 * connect at any time, including never if the user is offline).
		 */
		whenReady: idb.whenLoaded,
	};
}
