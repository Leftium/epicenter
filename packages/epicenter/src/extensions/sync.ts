import { createSyncProvider, type SyncProvider } from '@epicenter/sync';
import type { ExtensionFactory } from '../workspace/types';

/**
 * Sync extension configuration.
 *
 * Supports two auth modes:
 * - **Open**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Authenticated**: `url` + `getToken` — dynamic token refresh
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
 *     url: (id) => `ws://localhost:3913/rooms/${id}`,
 *   }))
 * ```
 *
 * @example Authenticated mode with HTTP bootstrap (cloud)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: (id) => `wss://sync.epicenter.so/rooms/${id}`,
 *     snapshotUrl: (id) => `https://sync.epicenter.so/rooms/${id}`,
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
	/** WebSocket URL for the room. */
	url: (workspaceId: string) => string;

	/**
	 * Token fetcher for authenticated mode. Called on each connect/reconnect.
	 * The same token is used for both WebSocket (`?token=` query param) and
	 * HTTP snapshot (`Authorization: Bearer` header).
	 */
	getToken?: (workspaceId: string) => Promise<string>;

	/**
	 * HTTP URL for initial state snapshot before WebSocket connect.
	 *
	 * When provided, fetches the full document via HTTP GET to pre-populate
	 * the local Y.Doc, making the subsequent WebSocket syncStep2 tiny.
	 * Omit to skip the prefetch and use pure WebSocket sync.
	 */
	snapshotUrl?: (workspaceId: string) => string;
};

/**
 * Creates a sync extension that connects after prior extensions are ready.
 *
 * Uses WebSocket for real-time sync, with an optional HTTP snapshot prefetch
 * (via `snapshotUrl`) to bootstrap the document before the WebSocket opens.
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
 *     url: 'ws://localhost:3913/rooms/{id}',
 *   }))
 * ```
 */
export function createSyncExtension(
	config: SyncExtensionConfig,
): ExtensionFactory {
	return ({ ydoc, awareness, whenReady: priorReady }) => {
		const workspaceId = ydoc.guid;

		const resolvedUrl = config.url(workspaceId);
		const resolvedSnapshotUrl = config.snapshotUrl?.(workspaceId);

		// Build provider — defer connection until prior extensions are ready
		let provider: SyncProvider = createSyncProvider({
			doc: ydoc,
			url: resolvedUrl,
			getToken: config.getToken
				? () => config.getToken!(workspaceId)
				: undefined,
			connect: false,
			awareness: awareness.raw,
			snapshotUrl: resolvedSnapshotUrl,
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
					url: resolvedUrl,
					getToken: config.getToken
						? () => config.getToken!(workspaceId)
						: undefined,
					connect: true,
					awareness: awareness.raw,
					snapshotUrl: resolvedSnapshotUrl,
				});
			},
			whenReady,
			destroy() {
				provider.destroy();
			},
		};
	};
}