import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	actionManifest,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	createDisposableCache,
	type DeviceDescriptor,
	toWsUrl,
} from '@epicenter/workspace';
import { createNoteBodyDoc } from '$lib/note-body-docs';
import type { NoteId } from '$lib/workspace';
import { openHoneycrisp as openHoneycrispDoc } from './index';

export function openHoneycrisp({
	auth,
	device,
}: {
	auth: AuthClient;
	device: DeviceDescriptor;
}) {
	const doc = openHoneycrispDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const noteBodyDocs = createDisposableCache(
		(noteId: NoteId) =>
			createNoteBodyDoc({
				noteId,
				workspaceId: doc.ydoc.guid,
				notesTable: doc.tables.notes,
				auth,
				apiUrl: APP_URLS.API,
			}),
		{ gcTime: 5_000 },
	);

	const sync = attachSync(doc.ydoc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb.whenLoaded,
		awareness: doc.awareness.raw,
		getToken: () => auth.getToken(),
		actions: doc.actions,
	});

	doc.awareness.setLocal({
		device: { ...device, offers: actionManifest(doc.actions) },
	});

	return {
		...doc,
		idb,
		noteBodyDocs,
		sync,
		whenReady: idb.whenLoaded,
	};
}
