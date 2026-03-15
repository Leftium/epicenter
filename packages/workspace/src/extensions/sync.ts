import {
	createSyncProvider,
	type SyncProvider,
	type SyncStatus,
} from '@epicenter/sync-client';
import type { ExtensionFactory } from '../workspace/types';

/**
 * Sync extension configuration.
 *
 * Supports two auth modes:
 * - **Open**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Authenticated**: `url` + `getToken` — dynamic token refresh
 *
 * The `url` callback returns an HTTP base URL. The sync provider derives the
 * WebSocket URL automatically (`https:` → `wss:`, `http:` → `ws:`).
 *
 * Chain last in the extension chain. Persistence loads local state first,
 * BroadcastChannel handles instant cross-tab sync, then WebSocket connects
 * for cross-device sync. The sync extension waits for all prior extensions
 * via `context.whenReady` before connecting.
 *
 * @example Recommended: persistence + BroadcastChannel + WebSocket
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/workspace/extensions/sync/web';
 * import { broadcastChannelSync } from '@epicenter/workspace/extensions/sync/broadcast-channel';
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `http://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 *
 * @example Authenticated mode (cloud)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `https://sync.epicenter.so/rooms/${id}`,
 *     getToken: async (workspaceId) => {
 *       const res = await fetch('/api/sync/token', {
 *         method: 'POST',
 *         body: JSON.stringify({ workspaceId }),
 *       });
 *       return (await res.json()).token;
 *     },
 *   }))
 * ```
 */
export type SyncExtensionConfig = {
	/** HTTP base URL for the room. The WebSocket URL is derived automatically. */
	url: (workspaceId: string) => string;

	/**
	 * Token fetcher for authenticated mode. Called on each connect/reconnect.
	 * The same token is used for both WebSocket (`?token=` query param) and
	 * HTTP snapshot (`Authorization: Bearer` header).
	 */
	getToken?: (workspaceId: string) => Promise<string | undefined>;
};

/**
 * Creates a sync extension that connects after prior extensions are ready.
 *
 * Uses WebSocket for cross-device real-time sync. For same-browser cross-tab
 * sync, use `broadcastChannelSync` — it provides sub-millisecond local sync
 * without a server round-trip.
 *
 * Lifecycle:
 * - **Waits for prior extensions**: `context.whenReady` resolves when all previously
 *   chained extensions (persistence, BroadcastChannel, etc.) are ready. The provider
 *   connects only after local state is loaded, ensuring an accurate state vector for
 *   the initial sync.
 * - **`whenReady`**: Resolves when the connection is initiated (after prior extensions).
 *   The UI renders from local state immediately — connection status is reactive via
 *   `provider`.
 *
 * @example Recommended: persistence + BroadcastChannel + WebSocket
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `http://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 */
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

export function createSyncExtension(
	config: SyncExtensionConfig,
): ExtensionFactory<SyncExtensionExports> {
	return ({ ydoc, awareness, whenReady: priorReady }) => {
		const workspaceId = ydoc.guid;

		const resolvedBaseUrl = config.url(workspaceId);
		const wsUrl = resolvedBaseUrl
			.replace(/^https:/, 'wss:')
			.replace(/^http:/, 'ws:');

		// Build provider — defer connection until prior extensions are ready
		const provider: SyncProvider = createSyncProvider({
			doc: ydoc,
			url: wsUrl,
			getToken: config.getToken
				? () => config.getToken!(workspaceId)
				: undefined,
			awareness: awareness.raw,
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
			onStatusChange: provider.onStatusChange.bind(provider),
			provider,
			/**
			 * Force an immediate disconnect + reconnect.
			 *
			 * Call after auth state changes (sign-in/sign-out) so the WebSocket
			 * reconnects with a fresh token from `getToken`. The supervisor loop
			 * calls `getToken()` fresh on each connection attempt, so a simple
			 * disconnect/connect cycle is sufficient.
			 */
			reconnect() {
				provider.disconnect();
				provider.connect();
			},
			whenReady,
			dispose() {
				provider.dispose();
			},
		};
	};
}
