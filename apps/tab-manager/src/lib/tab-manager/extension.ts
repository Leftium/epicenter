/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here.
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import type { AuthClient } from '@epicenter/auth-svelte';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	type PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import type { DeviceId } from '$lib/workspace/definition';

type TabManagerPeer = PeerIdentity & { id: DeviceId };
import { openTabManager as openTabManagerDoc } from './index';

/**
 * Construction is async because presence publishes the peer identity
 * synchronously at attach time (no two-step "online but no device yet"
 * window). Awaiting the identity up front means every peer sees a
 * well-formed `state.peer` from the first frame.
 *
 * `whenReady` still gates UI render on idb hydration; sync (the WebSocket)
 * is independent and connects whenever the network allows.
 */
export async function openTabManager({
	auth,
	peer,
}: {
	auth: AuthClient;
	peer: TabManagerPeer | Promise<TabManagerPeer>;
}) {
	const resolvedPeer = await Promise.resolve(peer);

	const doc = openTabManagerDoc({ deviceId: Promise.resolve(resolvedPeer.id) });

	const idb = attachIndexedDb(doc.ydoc);
	attachBroadcastChannel(doc.ydoc);

	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		getToken: async () => {
			await auth.whenSessionLoaded;

			const snapshot = auth.snapshot;
			return snapshot.status === 'signedIn' ? snapshot.session.token : null;
		},
	});
	const presence = sync.attachPresence({ peer: resolvedPeer });
	const rpc = sync.attachRpc(doc.actions);

	return {
		...doc,
		idb,
		sync,
		presence,
		rpc,
		/**
		 * Resolves when IndexedDB has hydrated the local snapshot. The UI
		 * can render with persisted data. Does NOT gate sync (the WebSocket
		 * can connect at any time, including never if the extension is offline).
		 */
		whenReady: idb.whenLoaded,
		peer: resolvedPeer,
	};
}
