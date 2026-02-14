import { createSyncProvider, type SyncProvider } from '@epicenter/sync';
import type * as Y from 'yjs';
import type { Lifecycle, MaybePromise } from '../shared/lifecycle';
import type { ExtensionFactory } from '../static/types';

/**
 * Sync extension configuration.
 *
 * Supports three auth modes:
 * - **Mode 1 (Open)**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Mode 2 (Shared Secret)**: `url` + `token` — static token
 * - **Mode 3 (External JWT)**: `url` + `getToken` — dynamic token refresh
 *
 * @example Open mode (local dev)
 * ```typescript
 * createSyncExtension({
 *   url: 'ws://localhost:3913/workspaces/{id}/sync',
 *   persistence: indexeddbPersistence,
 * })
 * ```
 *
 * @example Static token (self-hosted)
 * ```typescript
 * createSyncExtension({
 *   url: 'ws://my-server:3913/workspaces/{id}/sync',
 *   token: 'my-shared-secret',
 *   persistence: indexeddbPersistence,
 * })
 * ```
 *
 * @example Dynamic token (cloud)
 * ```typescript
 * createSyncExtension({
 *   url: 'wss://sync.epicenter.so/workspaces/{id}/sync',
 *   getToken: async (workspaceId) => {
 *     const res = await fetch('/api/sync/token', {
 *       method: 'POST',
 *       body: JSON.stringify({ workspaceId }),
 *     });
 *     return (await res.json()).token;
 *   },
 *   persistence: indexeddbPersistence,
 * })
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

	/**
	 * Persistence factory (REQUIRED).
	 *
	 * Loads local state before the WebSocket connects. This is the local-first pattern:
	 * render from local state immediately, sync in the background.
	 *
	 * Must return a {@link Lifecycle}: `{ whenReady, destroy }`.
	 *
	 * @example
	 * ```typescript
	 * persistence: indexeddbPersistence
	 * persistence: filesystemPersistence({ filePath: '/path/to/workspace.yjs' })
	 * persistence: ({ ydoc }) => ({ whenReady: Promise.resolve(), destroy: () => {} })
	 * ```
	 */
	persistence: (context: { ydoc: Y.Doc }) => Lifecycle;
};

/**
 * Creates a sync extension that orchestrates persistence + WebSocket sync.
 *
 * Lifecycle:
 * - **Persistence first**: `whenReady` resolves when local state loads.
 *   WebSocket connects in the background (non-blocking). The UI renders
 *   from local state immediately — connection status is reactive via `provider`.
 */
export function createSyncExtension(
	config: SyncExtensionConfig,
): ExtensionFactory {
	return ({ ydoc }) => {
		const workspaceId = ydoc.guid;

		// Resolve URL — supports string with {id} placeholder or function
		const resolvedUrl =
			typeof config.url === 'function'
				? config.url(workspaceId)
				: config.url.replace('{id}', workspaceId);

		// Build provider — defer connection until persistence loads
		let provider: SyncProvider = createSyncProvider({
			doc: ydoc,
			url: resolvedUrl,
			token: config.token,
			getToken: config.getToken
				? () => config.getToken!(workspaceId)
				: undefined,
			connect: false,
		});

		let persistenceCleanup: (() => MaybePromise<void>) | undefined;

		// Load persistence first, then kick off WebSocket in background.
		// whenReady = local data loaded (fast, reliable).
		// WebSocket connects in background — don't block on it.
		const whenReady = (async () => {
			const p = config.persistence({ ydoc });
			persistenceCleanup = p.destroy;
			await p.whenReady;
			// Kick off WebSocket in background
			provider.connect();
		})();

		return {
			exports: {
				get provider() {
					return provider;
				},
				/**
				 * Swap the sync rail (WebSocket target) without reinitializing persistence.
				 *
				 * Destroys the current provider, creates a new `SyncProvider` on the same
				 * `Y.Doc`, and connects it. Persistence (IndexedDB/filesystem) is untouched —
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
					});
				},
			},
			lifecycle: {
				whenReady,
				destroy() {
					persistenceCleanup?.();
					provider.destroy();
				},
			},
		};
	};
}
