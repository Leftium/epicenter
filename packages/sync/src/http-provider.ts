import { encodeSyncRequest } from '@epicenter/sync-core';
import * as Y from 'yjs';

// ============================================================================
// Types
// ============================================================================

/** Three-state connection model (no connecting/handshaking — there's no persistent connection). */
export type HttpSyncStatus = 'offline' | 'connected' | 'error';

export type HttpSyncProviderConfig = {
	/** The Y.Doc to sync. */
	doc: Y.Doc;
	/** HTTP URL for the sync endpoint (e.g., "https://api.example.com/rooms/my-room"). */
	url: string;
	/** Dynamic token fetcher for authenticated mode. */
	getToken?: () => Promise<string>;
	/** Base polling interval in ms. Default: 2000. */
	pollInterval?: number;
	/** Whether to connect immediately. Defaults to true. */
	connect?: boolean;
};

/**
 * A sync provider that syncs a Y.Doc with a server via HTTP polling.
 *
 * Uses a single `POST` endpoint that pushes local updates and pulls missing
 * state in one round-trip. No persistent connection — just fetch requests
 * on a timer with adaptive interval.
 */
export type HttpSyncProvider = {
	readonly status: HttpSyncStatus;
	readonly hasLocalChanges: boolean;
	/** Trigger an immediate poll (e.g., after user action, tab focus). */
	poll(): Promise<void>;
	connect(): Promise<void>;
	disconnect(): void;
	destroy(): void;
	onStatusChange(listener: (status: HttpSyncStatus) => void): () => void;
	onLocalChanges(listener: (hasLocalChanges: boolean) => void): () => void;
};

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates an HTTP polling sync provider for a Y.Doc.
 *
 * @example Open mode (localhost, no auth)
 * ```typescript
 * const provider = createHttpSyncProvider({
 *   doc: myDoc,
 *   url: 'http://localhost:3913/rooms/blog',
 * });
 * ```
 *
 * @example Authenticated mode
 * ```typescript
 * const provider = createHttpSyncProvider({
 *   doc: myDoc,
 *   url: 'https://sync.epicenter.so/rooms/blog',
 *   getToken: async () => {
 *     const res = await fetch('/api/sync/token');
 *     return (await res.json()).token;
 *   },
 * });
 * ```
 */
export function createHttpSyncProvider({
	doc,
	url,
	getToken,
	pollInterval: basePollInterval = 2000,
	connect: shouldConnect = true,
}: HttpSyncProviderConfig): HttpSyncProvider {
	// ========================================================================
	// Closure State
	// ========================================================================

	let status: HttpSyncStatus = 'offline';
	let interval = basePollInterval;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let pending: Uint8Array[] = [];
	let pendingSyncs = 0;
	let connected = false;
	/** In-flight guard to prevent overlapping sync requests. */
	let syncing = false;

	// ========================================================================
	// Event Listeners
	// ========================================================================

	const statusListeners = new Set<(status: HttpSyncStatus) => void>();
	const localChangesListeners = new Set<(hasLocalChanges: boolean) => void>();

	function setStatus(newStatus: HttpSyncStatus) {
		if (status === newStatus) return;
		status = newStatus;
		for (const listener of statusListeners) {
			listener(newStatus);
		}
	}

	function emitLocalChanges(hasChanges: boolean) {
		for (const listener of localChangesListeners) {
			listener(hasChanges);
		}
	}

	// ========================================================================
	// hasLocalChanges Tracking
	// ========================================================================

	function incrementPendingSyncs() {
		const wasClean = pendingSyncs === 0 && pending.length === 0;
		pendingSyncs++;
		if (wasClean) emitLocalChanges(true);
	}

	function decrementPendingSyncs(count: number) {
		pendingSyncs = Math.max(0, pendingSyncs - count);
		if (pendingSyncs === 0 && pending.length === 0) {
			emitLocalChanges(false);
		}
	}

	// ========================================================================
	// Core Sync
	// ========================================================================

	/**
	 * Send a sync request to the server. Optionally includes a batched update.
	 * Returns the HTTP response for adaptive interval logic.
	 */
	async function sync(update?: Uint8Array): Promise<Response> {
		const stateVector = Y.encodeStateVector(doc);
		const body = encodeSyncRequest(stateVector, update);

		const headers: Record<string, string> = {
			'content-type': 'application/octet-stream',
		};
		if (getToken) {
			headers.authorization = `Bearer ${await getToken()}`;
		}

		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: body as BodyInit,
		});

		if (response.status === 304) return response;
		if (!response.ok) throw new Error(`Sync failed: ${response.status}`);

		const diff = new Uint8Array(await response.arrayBuffer());
		Y.applyUpdateV2(doc, diff, 'remote');
		return response;
	}

	// ========================================================================
	// Drain Pending Updates
	// ========================================================================

	/**
	 * Drain pending updates into a merged update, clearing the flush timer.
	 * Returns the merged update and count, or undefined if nothing pending.
	 */
	function drainPending(): { update: Uint8Array; count: number } | undefined {
		if (pending.length === 0) return undefined;

		const updates = pending;
		const count = updates.length;
		pending = [];

		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}

		return { update: Y.mergeUpdatesV2(updates), count };
	}

	/**
	 * Perform a sync round-trip, draining any pending updates into the request.
	 * Updates the adaptive interval and status based on the response.
	 */
	async function syncWithDrain(): Promise<void> {
		const drained = drainPending();
		const response = await sync(drained?.update);
		if (drained) decrementPendingSyncs(drained.count);

		// Adapt polling interval based on whether the server had updates
		if (response.status === 200) {
			interval = Math.max(500, interval * 0.5);
		} else {
			interval = Math.min(interval * 1.5, 10_000);
		}

		setStatus('connected');
	}

	// ========================================================================
	// Update Batching
	// ========================================================================

	function handleDocUpdate(update: Uint8Array, origin: unknown) {
		if (origin === 'remote') return;
		pending.push(update);
		incrementPendingSyncs();
		flushTimer ??= setTimeout(flush, 50);
	}

	async function flush() {
		flushTimer = null;
		if (pending.length === 0 || syncing) return;

		syncing = true;
		try {
			await syncWithDrain();
		} catch (e) {
			console.warn('[HttpSyncProvider] Flush failed', e);
			setStatus('error');
		} finally {
			syncing = false;
		}
	}

	// ========================================================================
	// Adaptive Polling
	// ========================================================================

	function schedulePoll() {
		if (!connected) return;
		pollTimer = setTimeout(adaptivePoll, interval);
	}

	async function adaptivePoll() {
		pollTimer = null;
		if (!connected || syncing) {
			schedulePoll();
			return;
		}

		syncing = true;
		try {
			await syncWithDrain();
		} catch (e) {
			console.warn('[HttpSyncProvider] Poll failed', e);
			setStatus('error');
		} finally {
			syncing = false;
			schedulePoll();
		}
	}

	// ========================================================================
	// Browser Event Handlers
	// ========================================================================

	function handleVisibilityChange() {
		if (
			typeof document !== 'undefined' &&
			document.visibilityState === 'visible'
		) {
			provider.poll();
		}
	}

	function handleOnline() {
		provider.poll();
	}

	function addBrowserListeners() {
		if (typeof document !== 'undefined') {
			document.addEventListener('visibilitychange', handleVisibilityChange);
		}
		if (typeof window !== 'undefined') {
			window.addEventListener('online', handleOnline);
		}
	}

	function removeBrowserListeners() {
		if (typeof document !== 'undefined') {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		}
		if (typeof window !== 'undefined') {
			window.removeEventListener('online', handleOnline);
		}
	}

	// ========================================================================
	// Public API
	// ========================================================================

	const provider: HttpSyncProvider = {
		get status() {
			return status;
		},

		get hasLocalChanges() {
			return pendingSyncs > 0 || pending.length > 0;
		},

		async poll() {
			if (!connected || syncing) return;

			syncing = true;
			try {
				await syncWithDrain();
			} catch (e) {
				console.warn('[HttpSyncProvider] Poll failed', e);
				setStatus('error');
			} finally {
				syncing = false;
			}
		},

		async connect() {
			if (connected) return;
			connected = true;

			// Initial sync: state vector only, no update
			try {
				await sync();
				setStatus('connected');
			} catch (e) {
				console.warn('[HttpSyncProvider] Initial sync failed', e);
				setStatus('error');
			}

			// Attach handlers
			doc.on('updateV2', handleDocUpdate);
			addBrowserListeners();
			schedulePoll();
		},

		disconnect() {
			connected = false;

			if (pollTimer) {
				clearTimeout(pollTimer);
				pollTimer = null;
			}
			if (flushTimer) {
				clearTimeout(flushTimer);
				flushTimer = null;
			}

			doc.off('updateV2', handleDocUpdate);
			removeBrowserListeners();
			setStatus('offline');
		},

		destroy() {
			provider.disconnect();
			statusListeners.clear();
			localChangesListeners.clear();
		},

		onStatusChange(listener: (status: HttpSyncStatus) => void) {
			statusListeners.add(listener);
			return () => {
				statusListeners.delete(listener);
			};
		},

		onLocalChanges(listener: (hasLocalChanges: boolean) => void) {
			localChangesListeners.add(listener);
			return () => {
				localChangesListeners.delete(listener);
			};
		},
	};

	// Auto-connect
	if (shouldConnect) {
		provider.connect();
	}

	return provider;
}
