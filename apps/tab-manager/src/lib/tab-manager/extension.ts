/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here —
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	actionManifest,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	type DeviceDescriptor,
	toWsUrl,
} from '@epicenter/workspace';
import { openTabManager as openTabManagerDoc } from './index';

export function openTabManager({
	auth,
	device,
}: {
	auth: AuthClient;
	device: DeviceDescriptor;
}) {
	const doc = openTabManagerDoc();

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

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
		sync,
		whenReady: idb.whenLoaded,
	};
}
