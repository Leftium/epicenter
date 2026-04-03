import {
	createSyncProvider,
	type SyncProvider,
	type SyncStatus,
} from '@epicenter/sync-client';
import { RpcError } from '../../rpc/errors.js';
import type { DefaultRpcMap, RpcActionMap } from '../../rpc/types.js';
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
 * At workspace scope, peers publish identity (deviceId, client type).
 * At document scope, peers publish editing state (cursors, selections).
 */
export type PeerInfo = {
	/** Yjs awareness clientId (ephemeral, changes on reconnect). */
	clientId: number;
	/** Stable device identity (NanoID from localStorage), if published. */
	deviceId?: string;
	/** Client type ('extension', 'cli', 'desktop', 'web'), if published. */
	client?: string;
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
	 * const ext = peers.find(p => p.client === 'extension');
	 * ```
	 */
	peers(): PeerInfo[];

	/**
	 * Invoke an action on a remote peer in this room.
	 *
	 * Pass a type map (from `InferRpcMap`) for full type safety, or omit it
	 * for untyped calls. When typed, action names autocomplete, input is
	 * type-checked, and output is inferred.
	 *
	 * @example Typed (recommended when target app is in the same monorepo)
	 * ```typescript
	 * import type { TabManagerRpc } from '@epicenter/tab-manager/rpc';
	 *
	 * const { data, error } = await workspace.extensions.sync.rpc<TabManagerRpc>(
	 *   peer.clientId, 'tabs.close', { tabIds: [1, 2, 3] },
	 * );
	 * // data is { closedCount: number } | null — inferred from the map
	 * ```
	 *
	 * @example Untyped (when target's types aren't available)
	 * ```typescript
	 * const { data, error } = await workspace.extensions.sync.rpc(
	 *   peer.clientId, 'tabs.close', { tabIds: [1, 2, 3] },
	 * );
	 * // data is unknown
	 * ```
	 *
	 * @param target - Awareness clientId of the target peer
	 * @param action - Dot-path action name (e.g. 'tabs.close')
	 * @param input - Action input (serialized as JSON)
	 * @param options - Optional timeout override (default 5000ms)
	 */
	rpc<
		TMap extends RpcActionMap = DefaultRpcMap,
		TAction extends string & keyof TMap = string & keyof TMap,
	>(
		target: number,
		action: TAction,
		input?: TMap[TAction]['input'],
		options?: { timeout?: number },
	): Promise<{ data: TMap[TAction]['output'] | null; error: RpcError | null }>;
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
						deviceId: typeof state.deviceId === 'string' ? state.deviceId : undefined,
						client: typeof state.client === 'string' ? state.client : undefined,
					});
				}
				return peers;
			},

			async rpc<
				TMap extends RpcActionMap = DefaultRpcMap,
				TAction extends string & keyof TMap = string & keyof TMap,
			>(
				target: number,
				action: TAction,
				input?: TMap[TAction]['input'],
				options?: { timeout?: number },
			): Promise<{ data: TMap[TAction]['output'] | null; error: RpcError | null }> {
				if (target === ydoc.clientID) {
					return RpcError.ActionFailed({ action, cause: undefined });
				}

				const timeoutMs = options?.timeout ?? DEFAULT_RPC_TIMEOUT_MS;

				return new Promise((resolve) => {
					const requestId = provider.sendRpcRequest(target, action, input);

					const timer = setTimeout(() => {
						provider.pendingRequests.delete(requestId);
						resolve(RpcError.Timeout({ ms: timeoutMs }));
					}, timeoutMs);

					provider.pendingRequests.set(requestId, {
						resolve: (result) => {
							const error = result.error as RpcError | null;
							resolve({
								data: error ? null : (result.data as TMap[TAction]['output']),
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
