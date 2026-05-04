/**
 * Live browser state (tabs, windows, tab groups) is NOT stored here.
 * Chrome is the sole authority for ephemeral browser state. See
 * `browser-state.svelte.ts`.
 */

import type { AuthClient } from '@epicenter/auth';
import { APP_URLS } from '@epicenter/constants/vite';
import {
	attachAwareness,
	attachBroadcastChannel,
	attachIndexedDb,
	attachSync,
	createRemoteClient,
	PeerIdentity,
	toWsUrl,
} from '@epicenter/workspace';
import type { DeviceId } from '$lib/workspace/definition';

type TabManagerPeer = PeerIdentity & { id: DeviceId };

import { openTabManager as openTabManagerDoc } from './index';

/**
 * Construction is async because awareness publishes the peer identity
 * synchronously at attach time (no two-step "online but no device yet"
 * window). Awaiting the identity up front means every peer sees a
 * well-formed `state.peer` from the first frame.
 *
 * `whenLoaded` still gates UI render on idb hydration; sync (the WebSocket)
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

	const awareness = attachAwareness(doc.ydoc, {
		schema: { peer: PeerIdentity },
		initial: { peer: resolvedPeer },
	});
	const sync = attachSync(doc, {
		url: toWsUrl(`${APP_URLS.API}/workspaces/${doc.ydoc.guid}`),
		waitFor: idb,
		openWebSocket: auth.openWebSocket,
		onCredentialChange: auth.onChange,
		awareness,
	});
	const rpc = sync.attachRpc(doc.actions);
	const remote = createRemoteClient({ awareness, rpc });

	return {
		...doc,
		idb,
		awareness,
		sync,
		syncControl: sync,
		async clearLocalData() {
			await idb.clearLocal();
		},
		remote,
		rpc,
		whenLoaded: idb.whenLoaded,
		peer: resolvedPeer,
		device: resolvedPeer,
		[Symbol.dispose]() {
			doc[Symbol.dispose]();
		},
	};
}
