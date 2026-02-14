import type { ClientToken } from '@epicenter/y-sweet';
import { createYjsProvider, type YSweetProvider } from '@epicenter/y-sweet';
import type * as Y from 'yjs';
import type { Lifecycle, MaybePromise } from '../shared/lifecycle';
import type { ExtensionFactory } from '../static/types';

// Re-export the ClientToken type for consumers
export type { ClientToken as YSweetClientToken };

/**
 * Y-Sweet persistence sync configuration.
 *
 * Mirrors the provider's API: `auth` produces a {@link ClientToken},
 * `persistence` loads local state before connecting.
 *
 * @example Direct mode (local dev)
 * ```typescript
 * sync: ySweetPersistSync({
 *   auth: directAuth('http://localhost:8080'),
 *   persistence: indexeddbPersistence,
 * })
 * ```
 *
 * @example Authenticated mode (hosted infrastructure)
 * ```typescript
 * sync: ySweetPersistSync({
 *   auth: (docId) => fetch(`/api/token/${docId}`).then(r => r.json()),
 *   persistence: indexeddbPersistence,
 * })
 * ```
 *
 * @example With filesystem persistence
 * ```typescript
 * import { filesystemPersistence } from '@epicenter/hq/extensions/y-sweet-persist-sync/node';
 *
 * sync: ySweetPersistSync({
 *   auth: directAuth('http://localhost:8080'),
 *   persistence: filesystemPersistence({ filePath: '/path/to/workspace.yjs' }),
 * })
 * ```
 */
export type YSweetPersistSyncConfig = {
	/**
	 * Auth callback that returns a {@link ClientToken} for the given doc ID.
	 *
	 * For direct connections (local dev, Tailscale), use {@link directAuth}.
	 * For authenticated connections, return a token from your backend.
	 */
	auth: (docId: string) => Promise<ClientToken>;

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
 * Creates a Y-Sweet persistence sync extension.
 *
 * Orchestrates the lifecycle:
 * - **Persistence first**: `whenReady` resolves when local state loads.
 *   WebSocket connects in the background (non-blocking). The UI renders
 *   from local state immediately — connection status is reactive via `provider`.
 *
 * @see specs/20260212T190000-y-sweet-persistence-architecture.md
 */
export function ySweetPersistSync(
	config: YSweetPersistSyncConfig,
): ExtensionFactory {
	return ({ ydoc, awareness }) => {
		let currentAuth = config.auth;
		const authEndpoint = () => currentAuth(ydoc.guid);

		// Create provider — defer connection until persistence loads
		// TODO: Remove @ts-expect-error once Phase 1 (y-sweet provider awareness support) is complete
		let provider: YSweetProvider = createYjsProvider(
			ydoc,
			ydoc.guid,
			authEndpoint,
			// @ts-expect-error Phase 1 pending: y-sweet provider doesn't accept awareness parameter yet
			{ connect: false, awareness: awareness?.raw },
		);

		let persistenceCleanup: (() => MaybePromise<void>) | undefined;

		// Load persistence first, then kick off WebSocket in background.
		// whenReady = local data loaded (fast, reliable).
		// WebSocket connects in background — don't block on it.
		// Consumers subscribe to provider events for connection status.
		const whenReady = (async () => {
			const p = config.persistence({ ydoc });
			persistenceCleanup = p.destroy;
			await p.whenReady;
			// Kick off WebSocket in background — don't await it.
			// Consumers subscribe to provider events for connection status.
			provider.connect().catch(() => {
				// Suppress unhandled rejection. Connection errors
				// are surfaced reactively via provider status events.
			});
		})();

		// Build exports manually instead of using defineExtension() because
		// we need to preserve the provider getter (not spread it).
		// The getter ensures consumers always see the current provider after reconnect.
		return {
			exports: {
				get provider() {
					return provider;
				},
				/**
				 * Swap the sync rail (WebSocket target) without reinitializing persistence.
				 *
				 * Destroys the current provider, updates the auth callback, creates a new
				 * `YSweetProvider` on the same `Y.Doc`, and connects it. Persistence
				 * (IndexedDB/filesystem) is untouched — only the sync provider changes.
				 *
				 * @example
				 * ```typescript
				 * workspace.extensions.sync.reconnect(directAuth('https://cloud.example.com'));
				 * ```
				 */
				reconnect(newAuth: (docId: string) => Promise<ClientToken>) {
					provider.destroy();
					currentAuth = newAuth;
					// TODO: Remove biome-ignore and type assertion once Phase 1 (y-sweet provider awareness support) is complete
					provider = createYjsProvider(ydoc, ydoc.guid, authEndpoint, {
						awareness: awareness?.raw,
						// biome-ignore lint/suspicious/noExplicitAny: y-sweet provider types don't include awareness parameter yet (Phase 1 pending)
					} as any);
					provider.connect();
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
 * ySweetPersistSync({ auth: directAuth('http://localhost:8080'), persistence: ... })
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
