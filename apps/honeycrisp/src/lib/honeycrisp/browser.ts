import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	createDisposableCache,
	createPeerDirectory,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import { createNoteBodyDoc } from '$lib/note-body-docs';
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
	const bodySyncs = new Set<ReturnType<typeof attachSync>>();

	const noteBodyDocs = createDisposableCache(
		(noteId: NoteId) =>
			createNoteBodyDoc({
				noteId,
				workspaceId: doc.ydoc.guid,
				notesTable: doc.tables.notes,
				auth,
				apiUrl: APP_URLS.API,
				registerSync: (sync) => {
					bodySyncs.add(sync);
					return () => bodySyncs.delete(sync);
				},
			}),
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
			await auth.whenSessionLoaded;

			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
		awareness,
	});
	const peerDirectory = createPeerDirectory({ awareness, sync });
	const rpc = sync.attachRpc(doc.actions);

	return {
		...doc,
		idb,
		noteBodyDocs,
		awareness,
		sync,
		peerDirectory,
		rpc,
		/**
		 * Resolves when IndexedDB has hydrated the local snapshot. The UI can
		 * render with persisted data. Does NOT gate sync (the WebSocket can
		 * connect at any time, including never if the user is offline).
		 */
		whenReady: idb.whenLoaded,
		getAuthSyncTargets() {
			return [sync, ...bodySyncs];
		},
	};
}
