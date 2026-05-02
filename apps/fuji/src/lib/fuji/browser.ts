import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachRichText,
	attachSync,
	composeSyncControls,
	createBrowserDocumentFamily,
	createRemoteClient,
	DateTimeString,
	docGuid,
	onLocalUpdate,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import { clearDocument } from 'y-indexeddb';
import * as Y from 'yjs';
import type { EntryId } from '$lib/workspace';
import { openFuji as openFujiDoc } from './index';

function entryContentDocGuid({
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

	const entryContentDocs = createBrowserDocumentFamily(
		{
			ids() {
				return doc.tables.entries.getAllValid().map((entry) => entry.id);
			},
			create(entryId: EntryId) {
				const ydoc = new Y.Doc({
					guid: entryContentDocGuid({
						workspaceId: doc.ydoc.guid,
						entryId,
					}),
					gc: false,
				});
				const body = attachRichText(ydoc);
				const childIdb = attachIndexedDb(ydoc);
				const childSync = attachSync(ydoc, {
					url: toWsUrl(`${APP_URLS.API}/docs/${ydoc.guid}`),
					waitFor: childIdb.whenLoaded,
					getToken: async () => {
						await auth.whenLoaded;

						const snapshot = auth.snapshot;
						return snapshot.status === 'signedIn'
							? snapshot.session.token
							: null;
					},
				});

				onLocalUpdate(ydoc, () => {
					doc.tables.entries.update(entryId, {
						updatedAt: DateTimeString.now(),
					});
				});

				return {
					ydoc,
					body,
					idb: childIdb,
					sync: childSync,
					whenLoaded: childIdb.whenLoaded,
					[Symbol.dispose]() {
						ydoc.destroy();
					},
				};
			},
			clearLocalData(entryId: EntryId) {
				return clearDocument(
					entryContentDocGuid({
						workspaceId: doc.ydoc.guid,
						entryId,
					}),
				);
			},
		},
		{ gcTime: 5_000 },
	);
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
