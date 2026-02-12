import type { ClientToken } from '@epicenter/y-sweet';
import {
	createYjsProvider,
	STATUS_CONNECTED,
	type YSweetProvider,
} from '@epicenter/y-sweet';
import type * as Y from 'yjs';
import type { Lifecycle, MaybePromise } from '../shared/lifecycle';
import { defineExports, type ExtensionFactory } from '../dynamic/extension';
import type { KvField, TableDefinition } from '../dynamic/schema';

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
 *   persistence: indexeddbPersistence(),
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
	 * When provided, the extension defers WebSocket connection until persistence
	 * loads, ensuring the sync handshake sends an accurate state vector.
	 *
	 * Must return a {@link Lifecycle}: `{ whenSynced, destroy }`.
	 *
	 * @example
	 * ```typescript
	 * persistence: indexeddbPersistence()
	 * persistence: filesystemPersistence({ filePath: '/path/to/workspace.yjs' })
	 * persistence: (ydoc) => ({ whenSynced: Promise.resolve(), destroy: () => {} })
	 * ```
	 */
	persistence?: (ydoc: Y.Doc) => Lifecycle;
};

/**
 * Creates a Y-Sweet sync extension.
 *
 * Orchestrates the lifecycle: persistence loads first (if provided),
 * then WebSocket connects with an accurate state vector.
 *
 * @see specs/20260212T190000-y-sweet-persistence-architecture.md
 */
export function ySweetSync<
	TTableDefinitions extends readonly TableDefinition[],
	TKvFields extends readonly KvField[],
>(config: YSweetSyncConfig): ExtensionFactory<TTableDefinitions, TKvFields> {
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

		const whenSynced = hasPersistence
			? (async () => {
					const p = config.persistence!(ydoc);
					persistenceCleanup = p.destroy;
					await p.whenSynced;
					provider.connect();
					await waitForConnected(provider);
				})()
			: waitForConnected(provider);

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

function waitForConnected(provider: YSweetProvider): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (provider.status === STATUS_CONNECTED) {
		resolve();
		return promise;
	}
	const handleStatus = (status: string) => {
		if (status === STATUS_CONNECTED) {
			provider.off('connection-status', handleStatus);
			resolve();
		}
	};
	provider.on('connection-status', handleStatus);
	return promise;
}
