import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

/**
 * Configuration for creating a sync provider.
 *
 * Supports two auth modes:
 * - **Open**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Authenticated**: `url` + `getToken` — dynamic token refresh
 *
 * @example Open mode (localhost, no auth)
 * ```typescript
 * const provider = createSyncProvider({
 *   doc: myDoc,
 *   url: 'ws://localhost:3913/rooms/blog',
 * });
 * ```
 *
 * @example Authenticated mode
 * ```typescript
 * const provider = createSyncProvider({
 *   doc: myDoc,
 *   url: 'wss://sync.epicenter.so/rooms/blog',
 *   getToken: async () => {
 *     const res = await fetch('/api/sync/token');
 *     return (await res.json()).token;
 *   },
 * });
 * ```
 */
export type SyncProviderConfig = {
	/** The Y.Doc to sync. */
	doc: Y.Doc;

	/** WebSocket URL for the sync room (ws: or wss:). */
	url: string;

	/**
	 * Dynamic token fetcher for authenticated mode. Called on each connect/reconnect.
	 */
	getToken?: () => Promise<string | undefined>;

	/** External awareness instance. If provided, dispose() will NOT remove its states. Defaults to `new Awareness(doc)`. */
	awareness?: Awareness;
};

/**
 * Error context from the last failed connection attempt.
 *
 * Discriminated on `type`:
 * - `auth` — Token acquisition failed (`getToken` threw)
 * - `connection` — WebSocket failed to open or dropped
 */
export type SyncError =
	| { type: 'auth'; error: unknown }
	| { type: 'connection' };

/**
 * Connection status of the sync provider.
 *
 * Discriminated on `phase`:
 * - `offline` — Not connected, not trying to connect
 * - `connecting` — Attempting to open a WebSocket or performing handshake.
 *   Carries `attempt` (0 = first, 1+ = reconnecting) and optional `lastError`
 *   from the previous failed attempt.
 * - `connected` — Fully synced and communicating
 */
export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; attempt: number; lastError?: SyncError }
	| { phase: 'connected' };

/**
 * A sync provider instance returned by {@link createSyncProvider}.
 *
 * Manages a WebSocket connection to a Yjs sync server with:
 * - Supervisor loop architecture (one loop decides, event handlers report)
 * - Text ping/pong liveness detection via Cloudflare auto-response
 * - Exponential backoff with wakeable sleeper for browser online events
 * - Two-mode auth (open, dynamic token refresh)
 */
export type SyncProvider = {
	/** Current connection status. */
	readonly status: SyncStatus;

	/** The awareness instance for user presence. */
	readonly awareness: Awareness;

	/**
	 * Start connecting. Idempotent — safe to call multiple times.
	 * If a connect loop is already running, this is a no-op.
	 */
	connect(): void;

	/**
	 * Stop connecting and close the socket.
	 * Sets desired state to offline and wakes any sleeping backoff.
	 */
	disconnect(): void;

	/**
	 * Subscribe to status changes. Returns unsubscribe function.
	 *
	 * @example
	 * ```typescript
	 * const unsub = provider.onStatusChange((status) => {
	 *   switch (status.phase) {
	 *     case 'connected': console.log('Online'); break;
	 *     case 'connecting': console.log(`Attempt ${status.attempt}`); break;
	 *     case 'offline': console.log('Offline'); break;
	 *   }
	 * });
	 * // Later:
	 * unsub();
	 */
	onStatusChange(listener: (status: SyncStatus) => void): () => void;

	/**
	 * Clean up everything — disconnect, remove listeners, release resources.
	 * After calling dispose(), the provider is unusable.
	 */
	dispose(): void;
};
