import {
	createSyncProvider,
	type SyncProvider,
	type SyncStatus,
} from '@epicenter/sync-client';
import type { RpcError } from '../../rpc/errors.js';
import type { SharedExtensionContext } from '../../workspace/types.js';

const DEFAULT_RPC_TIMEOUT_MS = 5_000;

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
 * @example
 * ```typescript
 * import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
 *
 * createWorkspace(definition)
 *   .withExtension('persistence', indexeddbPersistence)
 *   .withExtension('broadcast', broadcastChannelSync)
 *   .withExtension('sync', createSyncExtension({
 *     url: (docId) => `ws://localhost:3913/rooms/${docId}`,
 *   }))
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

/**
 * Info about a connected peer, derived from awareness state.
 *
 * At workspace scope, peers publish device identity (deviceId, deviceType).
 * At document scope, peers publish editing state (cursors, selections).
 */
export type PeerInfo = {
	/** Yjs awareness clientId (ephemeral, changes on reconnect). */
	clientId: number;
	/** Stable device identity (NanoID from localStorage), if published. */
	deviceId?: string;
	/** Capability class ('browser-extension', 'cli', etc.), if published. */
	deviceType?: string;
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

	/**
	 * List connected peers in this room (excludes self).
	 *
	 * At workspace scope, returns all synced devices.
	 * At document scope, returns all clients editing this document.
	 *
	 * @example
	 * ```typescript
	 * const peers = workspace.extensions.sync.peers();
	 * const ext = peers.find(p => p.deviceType === 'browser-extension');
	 * ```
	 */
	peers(): PeerInfo[];

	/**
	 * Invoke an action on a remote peer in this room.
	 *
	 * Returns `{ data, error }` tuple. The target peer looks up the action
	 * in its registered handler and invokes it.
	 *
	 * @example
	 * ```typescript
	 * const { data, error } = await workspace.extensions.sync.rpc(
	 *   peer.clientId, 'tabs.close', { tabIds: [1, 2, 3] },
	 * );
	 * if (error) {
	 *   switch (error.name) {
	 *     case 'PeerOffline': // target not connected
	 *     case 'Timeout':     // no response in time
	 *     case 'ActionNotFound': // bad action path
	 *     case 'ActionFailed':   // handler error
	 *   }
	 * }
	 * ```
	 *
	 * @param target - Awareness clientId of the target peer
	 * @param action - Dot-path action name (e.g. 'tabs.close')
	 * @param input - Action input (serialized as JSON)
	 * @param options - Optional timeout override (default 5000ms)
	 */
	rpc<TData = unknown>(
		target: number,
		action: string,
		input?: unknown,
		options?: { timeout?: number },
	): Promise<{ data: TData | null; error: RpcError | null }>;
};

/**
 * Convert an HTTP(S) URL to its WebSocket equivalent.
 *
 * @example
 * ```typescript
 * createSyncExtension({
 *   url: (id) => toWsUrl(`${APP_URLS.API}/workspaces/${id}`),
 * })
 * // 'http://localhost:8787/...' → 'ws://localhost:8787/...'
 * // 'https://api.epicenter.so/...' → 'wss://api.epicenter.so/...'
 * ```
 */
export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/**
 * Creates a sync extension factory for any Y.Doc scope.
 *
 * Returns a factory function that receives `SharedExtensionContext` and
 * produces a sync provider with `peers()` and `rpc()`. Register with
 * `.withExtension()` for dual-scope (workspace + documents) or with
 * `.withWorkspaceExtension()` / `.withDocumentExtension()` for single-scope.
 *
 * Lifecycle:
 * - Waits for prior extensions (`whenReady`) before connecting, so local state
 *   is loaded first (accurate state vector for the initial sync handshake).
 * - `whenReady` resolves when the connection is initiated. The UI renders from
 *   local state immediately; connection status is reactive via `status`.
 */
export function createSyncExtension(config: SyncExtensionConfig): (
	context: SharedExtensionContext,
) => SyncExtensionExports & {
	whenReady: Promise<unknown>;
	dispose: () => void;
} {
	return ({ ydoc, whenReady: priorReady }) => {
		const docId = ydoc.guid;
		const { getToken } = config;
		const provider: SyncProvider = createSyncProvider({
			doc: ydoc,
			url: () => config.url(docId),
			getToken: getToken ? () => getToken(docId) : undefined,
		});
		const awareness = provider.awareness;

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

			peers() {
				const states = awareness.getStates();
				const selfId = ydoc.clientID;
				const peers: PeerInfo[] = [];
				for (const [clientId, state] of states) {
					if (clientId === selfId) continue;
					peers.push({
						clientId,
						deviceId: state.deviceId as string | undefined,
						deviceType: state.deviceType as string | undefined,
					});
				}
				return peers;
			},

			async rpc<TData = unknown>(
				target: number,
				action: string,
				input?: unknown,
				options?: { timeout?: number },
			): Promise<{ data: TData | null; error: RpcError | null }> {
				if (target === ydoc.clientID) {
					return {
						data: null,
					error: { name: 'ActionFailed', message: 'Cannot RPC to self \u2014 call the action directly', action, cause: undefined } as unknown as RpcError,
					};
				}

				const timeoutMs = options?.timeout ?? DEFAULT_RPC_TIMEOUT_MS;

				return new Promise((resolve) => {
					const requestId = provider.sendRpcRequest(target, action, input);

					const timer = setTimeout(() => {
						provider.pendingRequests.delete(requestId);
						resolve({
							data: null,
						error: { name: 'Timeout', message: `RPC call timed out after ${timeoutMs}ms`, ms: timeoutMs } as unknown as RpcError,
						});
					}, timeoutMs);

					provider.pendingRequests.set(requestId, {
						resolve: (result) => {
							const error = result.error as RpcError | null;
							resolve({
								data: error ? null : (result.data as TData),
								error,
							});
						},
						timer,
					});
				});
			},

			whenReady,
			dispose() {
				provider.dispose();
			},
		};
	};
}
