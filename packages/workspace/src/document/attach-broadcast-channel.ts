import { BC_ORIGIN, SYNC_ORIGIN } from '@epicenter/sync';
import * as Y from 'yjs';
import { createOwnedYjsKey } from './local-yjs-key.js';

export { BC_ORIGIN };

/**
 * BroadcastChannel cross-tab sync for a Yjs document.
 *
 * Broadcasts every local `updateV2` to same-origin tabs and applies incoming
 * updates from other tabs. Uses `ydoc.guid` as the default channel key so only
 * docs for the same workspace communicate.
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
 * @param opts.userId - Optional owner id for authenticated local channels.
 */
export function attachBroadcastChannel(
	ydoc: Y.Doc,
	{ userId }: { userId?: string } = {},
): void {
	if (typeof BroadcastChannel === 'undefined') {
		return;
	}

	const channelKey =
		userId === undefined ? ydoc.guid : createOwnedYjsKey(userId, ydoc.guid);
	const channel = new BroadcastChannel(`yjs:${channelKey}`);

	/** Broadcast local changes to other tabs.
	 *  Skips updates from BroadcastChannel itself (echo prevention) and from
	 *  the paired transport (e.g., WebSocket) to avoid cross-transport echo. */
	const handleUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === BC_ORIGIN) return;
		if (origin === SYNC_ORIGIN) return;
		channel.postMessage(update);
	};
	ydoc.on('updateV2', handleUpdate);

	/** Apply incoming changes from other tabs. */
	channel.onmessage = (event: MessageEvent) => {
		Y.applyUpdateV2(ydoc, new Uint8Array(event.data), BC_ORIGIN);
	};

	ydoc.once('destroy', () => {
		ydoc.off('updateV2', handleUpdate);
		channel.close();
	});
}
