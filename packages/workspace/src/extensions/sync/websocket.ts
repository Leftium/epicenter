import {
	createSyncProvider,
	type SyncProvider,
	type SyncStatus,
} from '@epicenter/sync-client';
import type { SharedExtensionContext } from '../../workspace/types';

/**
 * Sync extension configuration.
 *
 * Supports two auth modes:
 * - **Open**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Authenticated**: `url` + `getToken` — dynamic token refresh
 *
 * The `url` callback receives the Y.Doc's GUID (workspace GUID for workspace scope,
 * content doc GUID for document scope). The sync provider derives the WebSocket URL
 * automatically (`https:` → `wss:`, `http:` → `ws:`).
 *
 * Chain last in the extension chain. Persistence loads local state first,
 * BroadcastChannel handles instant cross-tab sync, then WebSocket connects
 * for cross-device sync. The sync extension waits for all prior extensions
 * via `context.whenReady` before connecting.
 *
 * @example Recommended: persistence + BroadcastChannel + WebSocket (both scopes)
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/workspace/extensions/persistence/indexeddb';
 * import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
 *
 * const sync = createSyncExtension({
 *   url: (docId) => `http://localhost:3913/rooms/${docId}`,
 * });
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 *   .withWorkspaceExtension('sync', sync.workspace)  // syncs workspace Y.Doc with awareness
 *   .withDocumentExtension('sync', sync.document)     // syncs each content Y.Doc
 * ```
 *
 * @example Authenticated mode (cloud)
 * ```typescript
 * const sync = createSyncExtension({
 *   url: (docId) => `https://sync.epicenter.so/rooms/${docId}`,
 *   getToken: async (docId) => {
 *     const res = await fetch('/api/sync/token', {
 *       method: 'POST',
 *       body: JSON.stringify({ docId }),
 *     });
 *     return (await res.json()).token;
 *   },
 * });
 * ```
 */
export type SyncExtensionConfig = {
	/**
	 * HTTP base URL for the room. Receives the Y.Doc's GUID.
	 *
	 * At workspace scope, this is the workspace ID. At document scope,
	 * this is the content Y.Doc's GUID (unique per document).
	 */
	url: (docId: string) => string;

	/**
	 * Token fetcher for authenticated mode. Called on each connect/reconnect.
	 * The same token is used for both WebSocket (`?token=` query param) and
	 * HTTP snapshot (`Authorization: Bearer` header).
	 */
	getToken?: (docId: string) => Promise<string | null>;

	/**
	 * Subscribe to auth token changes. Called once per Y.Doc during extension
	 * setup with a `reconnect` callback. Return an unsubscribe function.
	 *
	 * When the token changes, call `reconnect()` — the provider will
	 * disconnect the current WebSocket and start a new connection with
	 * a fresh token from `getToken`.
	 *
	 * @example Auth subscription
	 * ```typescript
	 * onTokenChange: auth.onTokenChange
	 * ```
	 */
	onTokenChange?: (reconnect: () => void) => () => void;
};

/** Exports available on `client.extensions.sync` after registration. */
export type SyncExtensionExports = {
	/** Current connection status. Shorthand for `provider.status`. */
	readonly status: SyncStatus;
	/** Subscribe to status changes. Shorthand for `provider.onStatusChange`. Returns unsubscribe function. */
	onStatusChange: SyncProvider['onStatusChange'];
	/** The sync provider instance for advanced use (awareness, etc.). */
	readonly provider: SyncProvider;
	/** Force disconnect + reconnect (e.g. after auth change). */
	reconnect(): void;
};

/**
 * Creates a sync extension that connects after prior extensions are ready.
 *
 * Syncs any Y.Doc (workspace or content) via WebSocket. Register with
 * `withExtension` to sync both the workspace Y.Doc and every content Y.Doc:
 *
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 *   .withExtension('sync', createSyncExtension({
 *     url: (docId) => `http://localhost:3913/rooms/${docId}`,
 *   }))
 * ```
 *
 * The `url` callback receives the Y.Doc's GUID—the workspace ID at workspace
 * scope, or the content doc's unique GUID at document scope. Each Y.Doc gets
 * its own WebSocket connection to its own room on the sync server.
 *
 * Lifecycle:
 * - Waits for prior extensions (`whenReady`) before connecting, so local state
 *   is loaded first (accurate state vector for the initial sync handshake).
 * - `whenReady` resolves when the connection is initiated. The UI renders from
 *   local state immediately; connection status is reactive via `provider`.
 */
export function createSyncExtension(
	config: SyncExtensionConfig,
): (context: SharedExtensionContext) => SyncExtensionExports & {
	whenReady: Promise<unknown>;
	dispose: () => void;
} {
	return ({ ydoc, whenReady: priorReady }) => {
		const docId = ydoc.guid;
		const provider: SyncProvider = createSyncProvider({
			doc: ydoc,
			url: () => {
				const base = config.url(docId);
				return base.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
			},
			getToken: config.getToken
				? () => config.getToken!(docId)
				: undefined,
		});

		const reconnect = () => {
			provider.disconnect();
			provider.connect();
		};

		const unsubTokenChange = config.onTokenChange?.(reconnect);

		// Wait for all prior extensions (persistence, etc.) then connect.
		// This ensures the Y.Doc has local state loaded before syncing,
		// giving an accurate state vector for the initial WebSocket handshake.
		const whenReady = (async () => {
			await priorReady;
			provider.connect();
		})();

		return {
			get status() {
				return provider.status;
			},
			onStatusChange: provider.onStatusChange.bind(provider),
			provider,
			/**
			 * Force an immediate disconnect + reconnect.
			 *
			 * Prefer `onTokenChange` for automatic reconnection on auth changes.
			 * Use this for manual reconnection (e.g. user-initiated retry button).
			 */
			reconnect,
			whenReady,
			dispose() {
				unsubTokenChange?.();
				provider.dispose();
			},
		};
	};
}
