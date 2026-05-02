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
import { createNoteBodyDoc, noteBodyDocGuid } from '$lib/note-body-docs';
import type { NoteId } from '$lib/workspace';
import { openHoneycrisp as openHoneycrispDoc } from './index';

export function openHoneycrisp({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: PeerIdentity;
}) {
	const doc = openHoneycrispDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const noteBodyDocs = createBrowserDocumentFamily({
		create(noteId: NoteId) {
			const document = createNoteBodyDoc({
				noteId,
				workspaceId: doc.ydoc.guid,
				notesTable: doc.tables.notes,
				auth,
				apiUrl: APP_URLS.API,
			});

			return { document, syncControl: document.sync };
		},
		async clearLocalData() {
			await Promise.all(
				doc.tables.notes.getAllValid().map((note) =>
					clearDocument(
						noteBodyDocGuid({
							workspaceId: doc.ydoc.guid,
							noteId: note.id,
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
		noteBodyDocs,
		awareness,
		sync,
		syncControl: composeSyncControls(sync, noteBodyDocs.syncControl),
		async clearLocalData() {
			await noteBodyDocs.clearLocalData();
			await idb.clearLocal();
		},
		remote,
		rpc,
		whenLoaded: idb.whenLoaded,
		[Symbol.dispose]() {
			noteBodyDocs[Symbol.dispose]();
			doc[Symbol.dispose]();
		},
	};
}
