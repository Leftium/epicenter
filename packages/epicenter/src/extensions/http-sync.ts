import { createHttpSyncProvider, type HttpSyncProvider } from '@epicenter/sync';
import type { ExtensionFactory } from '../workspace/types';

/**
 * HTTP sync extension configuration.
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
 *   .withExtension('sync', createHttpSyncExtension({
 *     url: 'http://localhost:3913/rooms/{id}',
 *   }))
 * ```
 *
 * @example Authenticated mode (cloud)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createHttpSyncExtension({
 *     url: 'https://sync.epicenter.so/rooms/{id}',
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
export type HttpSyncExtensionConfig = {
	/**
	 * HTTP URL. Use `{id}` as a placeholder for the workspace ID,
	 * or provide a function that receives the workspace ID and returns the URL.
	 */
	url: string | ((workspaceId: string) => string);

	/**
	 * Dynamic token fetcher for authenticated mode. Called on each connect/reconnect.
	 * Receives the workspace ID as argument.
	 */
	getToken?: (workspaceId: string) => Promise<string>;

	/** Base polling interval in ms. Default: 2000. */
	pollInterval?: number;
};

/**
 * Creates an HTTP sync extension that connects after prior extensions are ready.
 *
 * Lifecycle:
 * - **Waits for prior extensions**: `context.whenReady` resolves when all previously
 *   chained extensions (persistence, etc.) are ready. The HTTP provider connects only
 *   after local state is loaded, ensuring an accurate state vector for the initial sync.
 * - **`whenReady`**: Resolves when the initial HTTP sync completes (after prior
 *   extensions). The UI renders from local state immediately — connection status is
 *   reactive via `provider`.
 *
 * @example
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createHttpSyncExtension({
 *     url: 'http://localhost:3913/rooms/{id}',
 *   }))
 * ```
 */
export function createHttpSyncExtension(
	config: HttpSyncExtensionConfig,
): ExtensionFactory {
	return (ctx) => {
		const { ydoc } = ctx;
		const workspaceId = ydoc.guid;

		// Resolve URL — supports string with {id} placeholder or function
		const resolvedUrl =
			typeof config.url === 'function'
				? config.url(workspaceId)
				: config.url.replace('{id}', workspaceId);

		// Build provider — defer connection until prior extensions are ready
		let provider: HttpSyncProvider = createHttpSyncProvider({
			doc: ydoc,
			url: resolvedUrl,
			getToken: config.getToken
				? () => config.getToken!(workspaceId)
				: undefined,
			pollInterval: config.pollInterval,
			connect: false,
		});

		// Wait for all prior extensions (persistence, etc.) then connect.
		// This ensures the Y.Doc has local state loaded before syncing,
		// giving an accurate state vector for the initial HTTP handshake.
		// Note: provider.connect() is async (performs initial sync round-trip).
		const whenReady = (async () => {
			await ctx.whenReady;
			await provider.connect();
		})();

		return {
			get provider() {
				return provider;
			},
			/**
			 * Swap the sync rail (HTTP target) without affecting other extensions.
			 *
			 * Destroys the current provider, creates a new `HttpSyncProvider` on the same
			 * `Y.Doc`, and connects it. Other extensions (persistence, etc.) are untouched —
			 * only the sync provider changes.
			 *
			 * @example
			 * ```typescript
			 * workspace.extensions.sync.reconnect({
			 *   url: 'https://cloud.example.com/rooms/my-workspace',
			 * });
			 * ```
			 */
			reconnect(
				newConfig: {
					url?: string;
					getToken?: () => Promise<string>;
					pollInterval?: number;
				} = {},
			) {
				provider.destroy();
				provider = createHttpSyncProvider({
					doc: ydoc,
					url: newConfig.url ?? resolvedUrl,
					getToken: newConfig.getToken,
					pollInterval: newConfig.pollInterval ?? config.pollInterval,
					connect: true,
				});
			},
			whenReady,
			destroy() {
				provider.destroy();
			},
		};
	};
}
