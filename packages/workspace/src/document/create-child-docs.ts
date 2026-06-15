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

import * as Y from 'yjs';
import { createDisposableCache } from '../cache/disposable-cache.js';
import type { Guid } from '../shared/id.js';
import { type ConnectionConfig, connectDoc } from './connect-doc.js';

/**
 * Alias kept while the row-declared runtime migrates onto the shared
 * {@link ConnectionConfig}. Same shape; the `ChildDoc`-specific name retires
 * once `defineWorkspace(...).open(connection)` owns the connection.
 */
export type ChildDocConnection = ConnectionConfig;

/**
 * Bind the connection once and return a `childDocs(layout)` factory.
 *
 * @param connection - `(server, baseURL, ownerId, openWebSocket,
 *                       onReconnectSignal, deviceId)`, pre-bound into every
 *                      child doc this runtime opens.
 */
export function createChildDocs(connection: ConnectionConfig) {
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
			// A body is a doc like any other; `connectDoc` is the same wiring the
			// root uses. No action registry: the body's only writers are the
			// `attach*` layout and the server generation actor streaming in.
			const { idb } = connectDoc(ydoc, connection, { actions: {} });
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
