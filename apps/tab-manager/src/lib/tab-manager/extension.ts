/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here —
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	toWsUrl,
} from '@epicenter/workspace';
import { openTabManager as openTabManagerDoc } from './index';

export function openTabManager({ auth }: { auth: AuthClient }) {
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

	return {
		...doc,
		idb,
		sync,
		whenReady: idb.whenLoaded,
	};
}
