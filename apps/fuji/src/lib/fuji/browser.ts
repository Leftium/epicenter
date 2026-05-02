import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	composeSyncControls,
	createBrowserDocumentFamily,
	createRemoteClient,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import { clearDocument } from 'y-indexeddb';
import {
	createEntryContentDoc,
	entryContentDocGuid,
} from '$lib/entry-content-docs';
import type { EntryId } from '$lib/workspace';
import { openFuji as openFujiDoc } from './index';

export function openFuji({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const doc = openFujiDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const entryContentDocs = createBrowserDocumentFamily({
		create(entryId: EntryId) {
			const document = createEntryContentDoc({
				entryId,
				workspaceId: doc.ydoc.guid,
				entriesTable: doc.tables.entries,
				auth,
				apiUrl: APP_URLS.API,
			});

			return { document, syncControl: document.sync };
		},
		async clearLocalData() {
			await Promise.all(
				doc.tables.entries.getAllValid().map((entry) =>
					clearDocument(
						entryContentDocGuid({
							workspaceId: doc.ydoc.guid,
							entryId: entry.id,
						}),
					),
				),
			);
		},
		gcTime: 5_000,
	});
	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer },
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		getToken: async () => {
			await auth.whenLoaded;

			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
		awareness,
	});
	const rpc = sync.attachRpc(doc.actions);
	const remote = createRemoteClient({ awareness, rpc });

	return {
		...doc,
		idb,
		entryContentDocs,
		awareness,
		sync,
		syncControl: composeSyncControls(sync, entryContentDocs.syncControl),
		async clearLocalData() {
			await entryContentDocs.clearLocalData();
			await idb.clearLocal();
		},
		remote,
		rpc,
		whenLoaded: idb.whenLoaded,
		[Symbol.dispose]() {
			entryContentDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
