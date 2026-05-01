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
import { createEntryContentDoc } from '$lib/entry-content-docs';
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
	const contentSyncs = new Set<ReturnType<typeof attachSync>>();

	const entryContentDocs = createDisposableCache(
		(entryId: EntryId) =>
			createEntryContentDoc({
				entryId,
				workspaceId: doc.ydoc.guid,
				entriesTable: doc.tables.entries,
				auth,
				apiUrl: APP_URLS.API,
				registerSync: (sync) => {
					contentSyncs.add(sync);
					return () => contentSyncs.delete(sync);
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
		entryContentDocs,
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
			return [sync, ...contentSyncs];
		},
	};
}
