import { createSyncProvider, type SyncProvider } from '@epicenter/sync';
import type { ExtensionFactory } from '../workspace/types';

/**
 * WebSocket sync extension configuration.
 *
 * Supports two auth modes:
 * - **Open**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Authenticated**: `url` + `getToken` — dynamic token refresh
 *
 * Persistence is handled separately — add a persistence extension before sync
 * in the `.withExtension()` chain. The WebSocket sync extension waits for all
 * prior extensions via `context.whenReady` before connecting the WebSocket.
 *
 * @example Open mode (local dev)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createWsSyncExtension({
 *     url: 'ws://localhost:3913/rooms/{id}',
 *   }))
 * ```
 *
 * @example Authenticated mode with HTTP bootstrap (cloud)
 * ```typescript
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('sync', createWsSyncExtension({
 *     url: 'wss://sync.epicenter.so/rooms/{id}',
 *     snapshotUrl: 'https://sync.epicenter.so/rooms/{id}',
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
export type WsSyncExtensionConfig = {
	/**
	 * WebSocket URL. Use `{id}` as a placeholder for the workspace ID,
	 * or provide a function that receives the workspace ID and returns the URL.
	 */
	url: string | ((workspaceId: string) => string);

	/**
	 * Dynamic token fetcher for authenticated mode. Called on each connect/reconnect.
	 * Receives the workspace ID as argument.
	 */
	getToken?: (workspaceId: string) => Promise<string>;

	/**
	 * HTTP URL for initial state snapshot before WebSocket connect.
	 *
	 * When provided, fetches the full document via HTTP GET to pre-populate
	 * the local Y.Doc, making the subsequent WebSocket syncStep2 tiny.
	 * Use `{id}` as a placeholder for the workspace ID, or provide a function.
	 *
	 * Omit to skip the prefetch and use pure WebSocket sync.
	 */
	snapshotUrl?: string | ((workspaceId: string) => string);
};

/**
 * Creates a WebSocket sync extension that connects after prior extensions are ready.
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
 *   .withExtension('sync', createWsSyncExtension({
 *     url: 'ws://localhost:3913/rooms/{id}',
 *   }))
 * ```
 */
export function createWsSyncExtension(
	config: WsSyncExtensionConfig,
): ExtensionFactory {
	return ({ ydoc, awareness, whenReady: priorReady }) => {
		const workspaceId = ydoc.guid;

		// Resolve URL — supports string with {id} placeholder or function
		const resolvedUrl =
			typeof config.url === 'function'
				? config.url(workspaceId)
				: config.url.replace('{id}', workspaceId);

		// Resolve snapshotUrl — supports string with {id} placeholder or function
		const resolvedSnapshotUrl =
			typeof config.snapshotUrl === 'function'
				? config.snapshotUrl(workspaceId)
				: config.snapshotUrl?.replace('{id}', workspaceId);

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
			 * Swap the sync rail (WebSocket target) without affecting other extensions.
			 *
			 * Destroys the current provider, creates a new `SyncProvider` on the same
			 * `Y.Doc`, and connects it. Other extensions (persistence, etc.) are untouched —
			 * only the sync provider changes.
			 *
			 * @example
			 * ```typescript
			 * workspace.extensions.sync.reconnect({
			 *   url: 'wss://cloud.example.com/rooms/my-workspace',
			 * });
			 * ```
			 */
			reconnect(
				newConfig: {
					url?: string;
					getToken?: () => Promise<string>;
					snapshotUrl?: string;
				} = {},
			) {
				provider.destroy();
				provider = createSyncProvider({
					doc: ydoc,
					url: newConfig.url ?? resolvedUrl,
					getToken: newConfig.getToken,
					connect: true,
					awareness: awareness.raw,
					snapshotUrl: newConfig.snapshotUrl ?? resolvedSnapshotUrl,
				});
			},
			whenReady,
			destroy() {
				provider.destroy();
			},
		};
	};
}

/** @deprecated Use `createWsSyncExtension` instead. */
export const createSyncExtension = createWsSyncExtension;
/** @deprecated Use `WsSyncExtensionConfig` instead. */
export type SyncExtensionConfig = WsSyncExtensionConfig;
