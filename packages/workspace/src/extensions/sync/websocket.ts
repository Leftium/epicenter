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
 * content doc GUID for document scope). The URL must use the WebSocket protocol
 * (`ws:` or `wss:`).
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
 *   url: (docId) => `ws://localhost:3913/rooms/${docId}`,
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
 *   url: (docId) => `wss://sync.epicenter.so/rooms/${docId}`,
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
	 * WebSocket URL for the room. Receives the Y.Doc's GUID.
	 *
	 * At workspace scope, this is the workspace ID. At document scope,
	 * this is the content Y.Doc's GUID (unique per document).
	 *
	 * Must use `ws:` or `wss:` protocol. Use {@link toWsUrl} to convert
	 * an HTTP URL if your server config provides one.
	 */
	url: (docId: string) => string;

	/**
	 * Token fetcher for authenticated mode. Called on each connect/reconnect.
	 * The same token is used for both WebSocket (`?token=` query param) and
	 * HTTP snapshot (`Authorization: Bearer` header).
	 */
	getToken?: (docId: string) => Promise<string | null>;
};

/** Exports available on `client.extensions.sync` after registration. */
export type SyncExtensionExports = {
	/** Current connection status. */
	readonly status: SyncStatus;
	/** Subscribe to status changes. Returns unsubscribe function. */
	onStatusChange: SyncProvider['onStatusChange'];
	/**
	 * Force a fresh connection with new credentials.
	 *
	 * The supervisor loop restarts its current iteration with a fresh
	 * `getToken()` call—no disconnect/connect race condition.
	 */
	reconnect(): void;
};

/**
 * Convert an HTTP(S) URL to its WebSocket equivalent.
 *
 * Use this when your server config provides HTTP URLs (e.g. `APP_URLS.API`)
 * but you need a WebSocket URL for sync.
 *
 * @example
 * ```typescript
 * import { createSyncExtension, toWsUrl } from '@epicenter/workspace/extensions/sync/websocket';
 *
 * createSyncExtension({
 *   url: (id) => toWsUrl(`${APP_URLS.API}/workspaces/${id}`),
 * })
 * // 'http://localhost:8787/workspaces/my-ws' → 'ws://localhost:8787/workspaces/my-ws'
 * // 'https://api.epicenter.so/workspaces/my-ws' → 'wss://api.epicenter.so/workspaces/my-ws'
 * ```
 */
export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

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
 *     url: (docId) => `ws://localhost:3913/rooms/${docId}`,
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
export function createSyncExtension(config: SyncExtensionConfig): (
	context: SharedExtensionContext,
) => SyncExtensionExports & {
	whenReady: Promise<unknown>;
	dispose: () => void;
} {
	return ({ ydoc, whenReady: priorReady }) => {
		const docId = ydoc.guid;
		const provider: SyncProvider = createSyncProvider({
			doc: ydoc,
			url: () => config.url(docId),
			getToken: config.getToken ? () => config.getToken!(docId) : undefined,
		});

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
			onStatusChange: provider.onStatusChange,
			reconnect: provider.reconnect,
			whenReady,
			dispose() {
				provider.dispose();
			},
		};
	};
}
