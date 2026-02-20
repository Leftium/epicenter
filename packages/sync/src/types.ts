import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

/**
 * WebSocket constructor type for dependency injection.
 *
 * Allows swapping the WebSocket implementation for testing (mock)
 * or non-browser environments (e.g., `ws` package in Node.js).
 */
export type WebSocketConstructor = {
	new (url: string | URL, protocols?: string | string[]): WebSocket;
	prototype: WebSocket;
	readonly CLOSED: number;
	readonly CLOSING: number;
	readonly CONNECTING: number;
	readonly OPEN: number;
};

/**
 * Configuration for creating a sync provider.
 *
 * Supports three auth modes:
 * - **Mode 1 (Open)**: Just `url` — no auth (localhost, Tailscale, LAN)
 * - **Mode 2 (Shared Secret)**: `url` + `token` — static token
 * - **Mode 3 (External JWT)**: `url` + `getToken` — dynamic token refresh
 */
export type SyncProviderConfig = {
	/** The Y.Doc to sync. */
	doc: Y.Doc;

	/** WebSocket URL to connect to. */
	url: string;

	/** Static token for Mode 2 auth. Mutually exclusive with getToken. */
	token?: string;

	/**
	 * Dynamic token fetcher for Mode 3 auth. Called on each connect/reconnect.
	 * Mutually exclusive with token.
	 */
	getToken?: () => Promise<string>;

	/** Whether to connect immediately. Defaults to true. */
	connect?: boolean;

	/** External awareness instance. Defaults to `new Awareness(doc)`. */
	awareness?: Awareness;

	/** WebSocket constructor override for testing or non-browser environments. */
	WebSocketConstructor?: WebSocketConstructor;
};

/**
 * Connection status of the sync provider.
 *
 * Five-state model (vs y-websocket's three states):
 * - `offline` — Not connected, not trying to connect
 * - `connecting` — Attempting to open a WebSocket
 * - `handshaking` — WebSocket open, sync step 1/2 in progress
 * - `connected` — Fully synced and communicating
 * - `error` — Connection failed, will retry after backoff
 */
export type SyncStatus =
	| 'offline'
	| 'connecting'
	| 'handshaking'
	| 'connected'
	| 'error';

/**
 * A sync provider instance returned by {@link createSyncProvider}.
 *
 * Manages a WebSocket connection to a Yjs sync server with:
 * - Supervisor loop architecture (one loop decides, event handlers report)
 * - MESSAGE_SYNC_STATUS (102) heartbeat for `hasLocalChanges` and fast dead detection
 * - Exponential backoff with wakeable sleeper for browser online events
 * - Three-mode auth (open, static token, dynamic token refresh)
 */
export type SyncProvider = {
	/** Current connection status. */
	readonly status: SyncStatus;

	/** Whether there are unacknowledged local changes. */
	readonly hasLocalChanges: boolean;

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
	 *   console.log('Status:', status);
	 * });
	 * // Later:
	 * unsub();
	 * ```
	 */
	onStatusChange(listener: (status: SyncStatus) => void): () => void;

	/**
	 * Subscribe to local changes state changes. Returns unsubscribe function.
	 *
	 * Fires when `hasLocalChanges` toggles between true and false.
	 * Use this to show "Saving..." / "Saved" UI.
	 *
	 * @example
	 * ```typescript
	 * const unsub = provider.onLocalChanges((hasChanges) => {
	 *   statusBar.text = hasChanges ? 'Saving...' : 'Saved';
	 * });
	 * ```
	 */
	onLocalChanges(listener: (hasLocalChanges: boolean) => void): () => void;

	/**
	 * Clean up everything — disconnect, remove listeners, release resources.
	 * After calling destroy(), the provider is unusable.
	 */
	destroy(): void;
};
