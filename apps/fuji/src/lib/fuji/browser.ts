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
import { createEntryContentDoc } from '$lib/entry-content-docs';
import type { EntryId } from '$lib/workspace';
import { openFuji as openFujiDoc } from './index';

export function openFuji({
	auth,
	device,
}: {
	auth: AuthClient;
	device: DeviceDescriptor;
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
		entryContentDocs,
		sync,
		whenReady: idb.whenLoaded,
	};
}
