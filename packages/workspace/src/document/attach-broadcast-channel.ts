import { BC_ORIGIN, isTransportOrigin } from '@epicenter/sync';
import * as Y from 'yjs';

export { BC_ORIGIN };

/**
 * Local-only BroadcastChannel cross-tab sync for a Yjs document.
 *
 * Broadcasts every local `updateV2` to same-origin tabs and applies incoming
 * updates from other tabs. Uses `ydoc.guid` as the default channel key so only
 * docs for the same local workspace communicate. Do not use this for
 * authenticated browser workspaces where multiple signed-in users can share a
 * browser profile. Use `LocalOwner.attachBroadcastChannel` for those docs.
 *
 * Skips re-broadcasting updates that arrived from BroadcastChannel itself
 * (via `BC_ORIGIN`) and updates that arrived from WebSocket sync. Without
 * those guards, delivered updates would be re-broadcast to other tabs, and
 * those tabs would re-send them.
 *
 * No-ops gracefully when `BroadcastChannel` is unavailable (Node.js, SSR,
 * older browsers).
 *
 * @param ydoc - The Y.Doc to sync across tabs
 */
export function attachBroadcastChannel(ydoc: Y.Doc): void {
	attachBroadcastChannelWithKey(ydoc, ydoc.guid);
}

/**
 * Internal: attach a BroadcastChannel using an explicit channel key. Called
 * by `attachBroadcastChannel` (ydoc.guid) and by `LocalOwner.attachBroadcastChannel`
 * (owner-scoped key). Not re-exported through the package barrel.
 */
export function attachBroadcastChannelWithKey(
	ydoc: Y.Doc,
	channelKey: string,
): void {
	if (typeof BroadcastChannel === 'undefined') {
		return;
	}

	const channel = new BroadcastChannel(`yjs.${channelKey}`);

	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (isTransportOrigin(origin)) return;
		channel.postMessage(update);
	};
	ydoc.on('updateV2', handleUpdate);

	channel.onmessage = (event: MessageEvent) => {
		Y.applyUpdateV2(ydoc, new Uint8Array(event.data), BC_ORIGIN);
	};

	ydoc.once('destroy', () => {
		ydoc.off('updateV2', handleUpdate);
		channel.close();
	});
}
