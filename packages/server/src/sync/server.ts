import { Elysia } from 'elysia';
import type * as Y from 'yjs';
import type { AuthConfig } from './auth';
import { createSyncPlugin } from './plugin';

export const DEFAULT_SYNC_PORT = 3913;

export type SyncServerConfig = {
	port?: number;
	auth?: AuthConfig;
	onRoomCreated?: (roomId: string, doc: Y.Doc) => void;
	onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
};

/**
 * Create a standalone sync server with zero configuration.
 *
 * Rooms are created on demand when clients connect. No workspace schemas needed.
 * Includes a health/status endpoint at `GET /` listing active rooms.
 *
 * @example
 * ```typescript
 * import { createSyncServer } from '@epicenter/server/sync';
 *
 * // Zero-config relay
 * createSyncServer().start();
 *
 * // With auth
 * createSyncServer({ port: 3913, auth: { token: 'my-secret' } }).start();
 * ```
 */
export function createSyncServer(config?: SyncServerConfig) {
	const syncPlugin = createSyncPlugin({
		auth: config?.auth,
		onRoomCreated: config?.onRoomCreated,
		onRoomEvicted: config?.onRoomEvicted,
		// Standalone mode — no getDoc, rooms created on demand, default route
	});

	const app = new Elysia().use(syncPlugin).get('/', () => ({ status: 'ok' }));

	const port = config?.port ?? DEFAULT_SYNC_PORT;

	return {
		app,

		start() {
			app.listen(port);
			console.log(`[Sync Server] Listening on http://localhost:${port}`);
			return app.server;
		},

		destroy() {
			app.stop();
		},
	};
}
