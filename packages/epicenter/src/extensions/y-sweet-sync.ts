import type { ClientToken } from '@epicenter/y-sweet';
import {
	createYjsProvider,
	STATUS_CONNECTED,
	STATUS_OFFLINE,
	type YSweetProvider,
} from '@epicenter/y-sweet';
import type * as Y from 'yjs';
import { defineExports, type ExtensionFactory } from '../dynamic/extension';
import type { Lifecycle, MaybePromise } from '../shared/lifecycle';

// Re-export the ClientToken type for consumers
export type { ClientToken as YSweetClientToken };

/**
 * Y-Sweet sync configuration.
 *
 * Mirrors the provider's API: `auth` produces a {@link ClientToken},
 * `persistence` optionally loads local state before connecting.
 *
 * @example Direct mode (local dev)
 * ```typescript
 * sync: ySweetSync({
 *   auth: directAuth('http://localhost:8080'),
 * })
 * ```
 *
 * @example Authenticated mode (hosted infrastructure)
 * ```typescript
 * sync: ySweetSync({
 *   auth: (docId) => fetch(`/api/token/${docId}`).then(r => r.json()),
 * })
 * ```
 *
 * @example With persistence
 * ```typescript
 * import { indexeddbPersistence } from '@epicenter/hq/extensions/persistence/web';
 *
 * sync: ySweetSync({
 *   auth: directAuth('http://localhost:8080'),
 *   persistence: indexeddbPersistence,
 * })
 * ```
 */
export type YSweetSyncConfig = {
	/**
	 * Auth callback that returns a {@link ClientToken} for the given doc ID.
	 *
	 * For direct connections (local dev, Tailscale), use {@link directAuth}.
	 * For authenticated connections, return a token from your backend.
	 */
	auth: (docId: string) => Promise<ClientToken>;

	/**
	 * Optional persistence factory.
	 *
	 * When provided, `whenSynced` resolves after local state loads — the
	 * WebSocket connects in the background. This is the local-first pattern:
	 * render from local state immediately, sync in the background.
	 *
	 * Must return a {@link Lifecycle}: `{ whenSynced, destroy }`.
	 *
	 * @example
	 * ```typescript
	 * persistence: indexeddbPersistence
	 * persistence: filesystemPersistence({ filePath: '/path/to/workspace.yjs' })
	 * persistence: ({ ydoc }) => ({ whenSynced: Promise.resolve(), destroy: () => {} })
	 * ```
	 */
	persistence?: (context: { ydoc: Y.Doc }) => Lifecycle;
};

/**
 * Creates a Y-Sweet sync extension.
 *
 * Orchestrates the lifecycle:
 * - **With persistence**: `whenSynced` resolves when local state loads.
 *   WebSocket connects in the background (non-blocking). The UI renders
 *   from local state immediately — connection status is reactive via `provider`.
 * - **Without persistence**: `whenSynced` resolves on first WebSocket sync
 *   (rejects if disconnected before sync completes).
 *
 * @see specs/20260212T190000-y-sweet-persistence-architecture.md
 */
export function ySweetSync(config: YSweetSyncConfig): ExtensionFactory {
	return ({ ydoc }) => {
		const authEndpoint = () => config.auth(ydoc.guid);
		const hasPersistence = !!config.persistence;

		// Create provider — defer connection if persistence needs to load first
		const provider: YSweetProvider = createYjsProvider(
			ydoc,
			ydoc.guid,
			authEndpoint,
			{ connect: !hasPersistence },
		);

		let persistenceCleanup: (() => MaybePromise<void>) | undefined;

		// With persistence: whenSynced = local data loaded (fast, reliable).
		// WebSocket connects in background — don't block on it.
		//
		// Without persistence: whenSynced = first WebSocket sync (needs network).
		// Rejects on disconnect so callers can handle failure.
		const whenSynced = hasPersistence
			? (async () => {
					const p = config.persistence!({ ydoc });
					persistenceCleanup = p.destroy;
					await p.whenSynced;
					// Kick off WebSocket in background — don't await it.
					// Consumers subscribe to provider events for connection status.
					provider.connect();
				})()
			: waitForFirstSync(provider);

		return defineExports({
			provider,
			whenSynced,
			destroy: () => {
				persistenceCleanup?.();
				provider.destroy();
			},
		});
	};
}

/**
 * Direct auth helper for local development.
 *
 * Constructs a {@link ClientToken} by converting the server URL to a WebSocket URL.
 * No authentication — use for local dev or private networks (Tailscale).
 *
 * Y-Sweet WebSocket URL format: `ws://{host}/d/{docId}/ws`
 *
 * @example
 * ```typescript
 * ySweetSync({ auth: directAuth('http://localhost:8080') })
 * ```
 */
export function directAuth(
	serverUrl: string,
): (docId: string) => Promise<ClientToken> {
	return (docId: string) => {
		const url = new URL(serverUrl);
		const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		return Promise.resolve({
			url: `${wsProtocol}//${url.host}/d/${docId}/ws`,
		});
	};
}

/**
 * Waits for the provider's first successful sync.
 *
 * Used when there's no local persistence — the network is the only data source.
 * Rejects if the provider transitions to OFFLINE (via disconnect/destroy)
 * before sync completes, so callers aren't left hanging forever.
 */
function waitForFirstSync(provider: YSweetProvider): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();

	if (provider.status === STATUS_CONNECTED) {
		resolve();
		return promise;
	}

	const handleStatus = (status: string) => {
		if (status === STATUS_CONNECTED) {
			cleanup();
			resolve();
		}
		if (status === STATUS_OFFLINE) {
			cleanup();
			reject(new Error('Provider disconnected before sync completed'));
		}
	};

	const cleanup = () => provider.off('connection-status', handleStatus);
	provider.on('connection-status', handleStatus);

	return promise;
}
