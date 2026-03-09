import { createSyncProvider, type SyncProvider } from '@epicenter/sync-client';
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
 * Persistence is handled separately — add a persistence extension before sync
 * in the `.withExtension()` chain. The sync extension waits for all prior
 * extensions via `context.whenReady` before connecting.
 *
 * @example Open mode (local dev)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `http://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 *
 * @example Authenticated mode (cloud)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
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
	getToken?: (workspaceId: string) => Promise<string>;
};

/**
 * Creates a sync extension that connects after prior extensions are ready.
 *
 * Uses WebSocket for real-time sync.
 *
 * Lifecycle:
 * - **Waits for prior extensions**: `context.whenReady` resolves when all previously
 *   chained extensions (persistence, etc.) are ready. The provider connects only after
 *   local state is loaded, ensuring an accurate state vector for the initial sync.
 * - **`whenReady`**: Resolves when the connection is initiated (after prior extensions).
 *   The UI renders from local state immediately — connection status is reactive via
 *   `provider`.
 *
 * @example
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `http://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 */
export function createSyncExtension(
	config: SyncExtensionConfig,
): ExtensionFactory {
	return ({ ydoc, awareness, whenReady: priorReady }) => {
		const workspaceId = ydoc.guid;

		const resolvedBaseUrl = config.url(workspaceId);
		const wsUrl = resolvedBaseUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');

		// Build provider — defer connection until prior extensions are ready
		let provider: SyncProvider = createSyncProvider({
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
			get provider() {
				return provider;
			},
			/**
			 * Force an immediate disconnect + reconnect using the original config.
			 *
			 * Call after auth state changes (sign-in/sign-out) so the WebSocket
			 * reconnects with a fresh token from `getToken`.
			 */
			reconnect() {
				provider.destroy();
				provider = createSyncProvider({
					doc: ydoc,
					url: wsUrl,
					getToken: config.getToken
						? () => config.getToken!(workspaceId)
						: undefined,
					awareness: awareness.raw,
				});
				provider.connect();
			},
			whenReady,
			destroy() {
				provider.destroy();
			},
		};
	};
}
