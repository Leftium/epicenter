/**
 * `createChildDocs`: the bound child-doc runtime (lifecycle layer).
 *
 * A collaborative body (a chat transcript, a prose note, a code snippet) is its
 * own synced `Y.Doc`, addressed by a stable {@link Guid}. Three concerns recur
 * every time an app opens one:
 *
 *  - **lifecycle**: same guid -> one shared `Y.Doc`; N opens require N disposes;
 *    a grace window survives route/pane swaps. ({@link createDisposableCache})
 *  - **connection**: local IndexedDB persistence + cloud sync, both partitioned
 *    by `(server, ownerId)` and pointed at the room for this guid.
 *  - **shape**: the CRDT layout and its writer policy, owned by an
 *    `attach*(ydoc)` function ({@link attachPlainText}, {@link attachRichText},
 *    `attachChatTranscript`).
 *
 * Before this runtime, every app hand-wired all three inline (Zhongwen's
 * `conversationDocs`, Fuji's `entryBodies`, Honeycrisp's `noteBodyDocs`). This
 * factory binds the connection once and lets each app declare only the shape:
 *
 * ```ts
 * // once, in the app's signed-in composition:
 * const childDocs = createChildDocs({ ...signedIn, deviceId });
 *
 * // once per layout (connection pre-bound, shape injected):
 * const conversations = childDocs(attachChatTranscript);
 *
 * // per open (lazy; same guid shares one Y.Doc):
 * using convo = conversations.open(conversationDocGuid(id));
 * convo.appendUser({ id, content, createdAt });
 * ```
 *
 * Each `childDocs(layout)` call is one {@link createDisposableCache} keyed by
 * guid. A guid encodes its `field` segment (see {@link docGuid}), so distinct
 * fields never collide and the "one guid, one layout" invariant holds by
 * construction: opening the same guid through two different layouts is a
 * programmer error the guid grammar makes hard to reach.
 *
 * Sync is opened for its side effect; the `openCollaboration` handle is
 * intentionally orphaned, exactly as the hand-wired caches did. Teardown
 * cascades from `ydoc.destroy()` when the cache evicts the entry.
 *
 * @module
 */

import type { OwnerId } from '@epicenter/identity';
import * as Y from 'yjs';
import { createDisposableCache } from '../cache/disposable-cache.js';
import type { Guid } from '../shared/id.js';
import { attachLocalStorage } from './attach-local-storage.js';
import type { DeviceId } from './device-id.js';
import {
	type OnReconnectSignal,
	type OpenWebSocketFn,
	openCollaboration,
} from './open-collaboration.js';
import { roomWsUrl } from './transport.js';

/**
 * Everything `createChildDocs` needs to connect a child doc to local storage
 * and cloud sync. Structurally a superset of the auth `SignedIn` payload plus
 * the per-client `deviceId`; typed against workspace-native types so the
 * runtime never imports from the auth/Svelte layer.
 *
 * Pass `{ ...signedIn, deviceId }` at the call site.
 */
export type ChildDocConnection = {
	/** API origin host (e.g. `api.epicenter.so`); partitions local storage. */
	server: string;
	/** Full API origin URL (e.g. `https://api.epicenter.so`); scheme upgrades to `wss://`. */
	baseURL: string;
	ownerId: OwnerId;
	/** Bearer-attached WebSocket opener (`auth.openWebSocket`). */
	openWebSocket: OpenWebSocketFn;
	/** Auth state-change publication; sync reconnects after token refreshes. */
	onReconnectSignal: OnReconnectSignal;
	deviceId: DeviceId;
};

/**
 * Bind the connection once and return a `childDocs(layout)` factory.
 *
 * @param connection - `(server, baseURL, ownerId, openWebSocket,
 *                       onReconnectSignal, deviceId)`, pre-bound into every
 *                      child doc this runtime opens.
 */
export function createChildDocs(connection: ChildDocConnection) {
	/**
	 * Create a guid-keyed cache of child docs shaped by `layout`. The connection
	 * is already bound; the cache lazily opens each doc on first `open(guid)` and
	 * tears it down a grace window after the last dispose.
	 *
	 * @param layout  - `attach*(ydoc)` function owning the CRDT shape and writer
	 *                  policy. Its returned handle is spread onto the open handle.
	 * @param options - `gcTime` forwarded to the underlying cache (default 5s).
	 */
	return function childDocs<TLayout extends object>(
		layout: (ydoc: Y.Doc) => TLayout,
		options: { gcTime?: number } = {},
	) {
		return createDisposableCache((guid: Guid) => {
			const ydoc = new Y.Doc({ guid, gc: true });
			const idb = attachLocalStorage(ydoc, {
				server: connection.server,
				ownerId: connection.ownerId,
			});
			// Sync is opened for its side effect: it lets the server generation
			// actor stream into the doc and every signed-in device watch live. The
			// handle is orphaned on purpose; teardown cascades from `ydoc.destroy()`.
			openCollaboration(ydoc, {
				url: roomWsUrl({
					baseURL: connection.baseURL,
					ownerId: connection.ownerId,
					guid,
					deviceId: connection.deviceId,
				}),
				openWebSocket: connection.openWebSocket,
				onReconnectSignal: connection.onReconnectSignal,
				waitFor: idb.whenLoaded,
				actions: {},
			});
			return {
				...layout(ydoc),
				/** The doc's guid (the cache key); callers needing the room id read it here, not the raw `ydoc`. */
				guid,
				/** Resolves when local IndexedDB state has replayed into the doc. */
				whenLoaded: idb.whenLoaded,
				[Symbol.dispose]() {
					ydoc.destroy();
				},
			};
		}, options);
	};
}
