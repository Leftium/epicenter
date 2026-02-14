import { createSyncProvider, type SyncProvider } from '@epicenter/sync';
import type { ExtensionFactory } from '../static/types';

/**
 * Sync extension configuration.
 *
 * Supports three auth modes:
 * - **Mode 1 (Open)**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Mode 2 (Shared Secret)**: `url` + `token` — static token
 * - **Mode 3 (External JWT)**: `url` + `getToken` — dynamic token refresh
 *
 * Persistence is handled separately — add a persistence extension before sync
 * in the `.withExtension()` chain. The sync extension waits for all prior
 * extensions via `context.whenReady` before connecting the WebSocket.
 *
 * @example Open mode (local dev)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: 'ws://localhost:3913/workspaces/{id}/sync',
 *   }))
 * ```
 *
 * @example Static token (self-hosted)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: 'ws://my-server:3913/workspaces/{id}/sync',
 *     token: 'my-shared-secret',
 *   }))
 * ```
 *
 * @example Dynamic token (cloud)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: 'wss://sync.epicenter.so/workspaces/{id}/sync',
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
	/**
	 * WebSocket URL. Use `{id}` as a placeholder for the workspace ID,
	 * or provide a function that receives the workspace ID and returns the URL.
	 */
	url: string | ((workspaceId: string) => string);

	/** Static token for Mode 2 auth. Mutually exclusive with getToken. */
	token?: string;

	/**
	 * Dynamic token fetcher for Mode 3 auth. Called on each connect/reconnect.
	 * Receives the workspace ID as argument.
	 * Mutually exclusive with token.
	 */
	getToken?: (workspaceId: string) => Promise<string>;
};

/**
 * Creates a sync extension that connects a WebSocket after prior extensions are ready.
 *
 * Lifecycle:
 * - **Waits for prior extensions**: `context.whenReady` resolves when all previously
 *   chained extensions (persistence, etc.) are ready. The WebSocket connects only after
 *   local state is loaded, ensuring an accurate state vector for the initial sync.
 * - **`whenReady`**: Resolves when the WebSocket connection is initiated (after prior
 *   extensions). The UI renders from local state immediately — connection status is
 *   reactive via `provider`.
 *
 * @example
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createSyncExtension({
 *     url: 'ws://localhost:3913/workspaces/{id}/sync',
 *   }))
 * ```
 */
export function createSyncExtension(
	config: SyncExtensionConfig,
): ExtensionFactory {
	return (client) => {
		const { ydoc, awareness } = client;
		const workspaceId = ydoc.guid;

		// Resolve URL — supports string with {id} placeholder or function
		const resolvedUrl =
			typeof config.url === 'function'
				? config.url(workspaceId)
				: config.url.replace('{id}', workspaceId);

		// Build provider — defer connection until prior extensions are ready
		let provider: SyncProvider = createSyncProvider({
			doc: ydoc,
			url: resolvedUrl,
			token: config.token,
			getToken: config.getToken
				? () => config.getToken!(workspaceId)
				: undefined,
			connect: false,
			awareness: awareness.raw,
		});

		// Wait for all prior extensions (persistence, etc.) then connect.
		// This ensures the Y.Doc has local state loaded before syncing,
		// giving an accurate state vector for the initial WebSocket handshake.
		const whenReady = (async () => {
			await client.whenReady;
			provider.connect();
		})();

		return {
			exports: {
				get provider() {
					return provider;
				},
				/**
				 * Swap the sync rail (WebSocket target) without affecting other extensions.
				 *
				 * Destroys the current provider, creates a new `SyncProvider` on the same
				 * `Y.Doc`, and connects it. Other extensions (persistence, etc.) are untouched —
				 * only the sync provider changes.
				 *
				 * @example
				 * ```typescript
				 * workspace.extensions.sync.reconnect({
				 *   url: 'wss://cloud.example.com/workspaces/my-workspace/sync',
				 * });
				 * ```
				 */
				reconnect(
					newConfig: {
						url?: string;
						token?: string;
						getToken?: () => Promise<string>;
					} = {},
				) {
					provider.destroy();
					provider = createSyncProvider({
						doc: ydoc,
						url: newConfig.url ?? resolvedUrl,
						token: newConfig.token,
						getToken: newConfig.getToken,
						connect: true,
						awareness: awareness.raw,
					});
				},
			},
			lifecycle: {
				whenReady,
				destroy() {
					provider.destroy();
				},
			},
		};
	};
}
