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
 *   .withWorkspaceExtension('sync', sync.workspace)  // syncs workspace Y.Doc with awareness + RPC
 *   .withDocumentExtension('sync', sync.document)     // syncs each content Y.Doc
 * ```
 */
export type SyncExtensionConfig = {
	url: (docId: string) => string;
	getToken?: (docId: string) => Promise<string | null>;
};

/** Info about a connected peer, derived from awareness state. */
export type PeerInfo = {
	/** Yjs awareness clientId (ephemeral, for targeting RPC calls). */
	clientId: number;
	/** Stable device identity (NanoID from localStorage), if published. */
	deviceId?: string;
	/** Capability class ('browser-extension', 'cli', etc.), if published. */
	deviceType?: string;
};

/** Exports available on `client.extensions.sync` after workspace registration. */
export type SyncExtensionExports = {
	readonly status: SyncStatus;
	onStatusChange: SyncProvider['onStatusChange'];
	reconnect(): void;
	peers(): PeerInfo[];
	rpc<TData = unknown>(
		target: number,
		action: string,
		input?: unknown,
		options?: { timeout?: number },
	): Promise<{ data: TData | null; error: RpcError | null }>;
};

/** Convert an HTTP(S) URL to its WebSocket equivalent. */
export function toWsUrl(httpUrl: string): string {
	return httpUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

/**
 * Creates a sync extension with split workspace/document factories.
 *
 * Returns `{ workspace, document }`:
 * - `workspace`: Syncs the workspace Y.Doc with awareness, peers(), and rpc().
 * - `document`: Syncs each content Y.Doc (basic sync only).
 */
export function createSyncExtension(config: SyncExtensionConfig) {
	function createProviderForDoc(ydoc: import('yjs').Doc, priorReady: Promise<unknown>) {
		const docId = ydoc.guid;
		const { getToken } = config;
		const provider: SyncProvider = createSyncProvider({
			doc: ydoc,
			url: () => config.url(docId),
			getToken: getToken ? () => getToken(docId) : undefined,
		});

		const whenReady = (async () => {
			await priorReady;
			provider.connect();
		})();

		return { provider, whenReady };
	}

	return {
		/**
		 * Workspace factory — syncs the workspace Y.Doc with peers() and rpc().
		 */
		workspace({ ydoc, whenReady: priorReady }: SharedExtensionContext): SyncExtensionExports & {
			whenReady: Promise<unknown>;
			dispose: () => void;
		} {
			const { provider, whenReady } = createProviderForDoc(ydoc, priorReady);
			const awareness = provider.awareness;

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
							error: { tag: 'ActionFailed', message: 'Cannot RPC to self \u2014 call the action directly', name: 'ActionFailed', action, cause: undefined } as unknown as RpcError,
						};
					}

					const timeoutMs = options?.timeout ?? DEFAULT_RPC_TIMEOUT_MS;

					return new Promise((resolve) => {
						const requestId = provider.sendRpcRequest(target, action, input);

						const timer = setTimeout(() => {
							provider.pendingRequests.delete(requestId);
							resolve({
								data: null,
								error: { tag: 'Timeout', message: `RPC call timed out after ${timeoutMs}ms`, name: 'Timeout', ms: timeoutMs } as unknown as RpcError,
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
		},

		/**
		 * Document factory — syncs each content Y.Doc (basic sync only).
		 */
		document({ ydoc, whenReady: priorReady }: SharedExtensionContext) {
			const { provider, whenReady } = createProviderForDoc(ydoc, priorReady);

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
		},
	};
}
