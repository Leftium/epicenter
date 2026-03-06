import {
	corsMiddleware,
	createAuthMiddleware,
	createOAuthMetadataHandler,
	createOidcConfigHandler,
	factory,
	handleAiChat,
	handleProxy,
} from '@epicenter/server-remote';
import { createStandaloneAuth, seedAdminIfNeeded } from './auth';
import type { StandaloneAuthConfig } from './auth';
import { BunSqliteUpdateLog } from './storage';
import { mountSyncRoutes, websocket } from './sync-adapter';

declare const Bun: {
	serve(options: {
		port: number;
		fetch: (req: Request) => Response | Promise<Response>;
		websocket: unknown;
	}): { port: number; stop(): void };
};

export type StandaloneHubConfig = {
	/** Authentication mode. Defaults to `{ mode: 'none' }`. */
	auth?: StandaloneAuthConfig;

	/**
	 * Preferred port. Falls back to `PORT` env, then 3913.
	 * If the port is taken, Bun.serve will throw — the caller should handle this.
	 */
	port?: number;

	/**
	 * Path to the SQLite database file for Yjs document persistence.
	 * Defaults to `DATA_DIR` env var + `/sync.db`, or `./data/sync.db`.
	 */
	dbPath?: string;

	/** Sync lifecycle hooks. */
	sync?: {
		onRoomCreated?: (roomId: string) => void;
		onRoomEvicted?: (roomId: string) => void;
		evictionTimeout?: number;
	};
};

/**
 * Create a standalone remote hub server.
 *
 * Returns a Hono app and lifecycle methods (`start`, `stop`).
 * The `stop()` method calls `roomManager.destroy()` to clear all rooms,
 * timers, and Y.Docs, and closes the SQLite database.
 *
 * @example
 * ```typescript
 * const hub = createRemoteHub({ auth: { mode: 'token', token: 'secret' } });
 * const { port } = await hub.start();
 * console.log(`Hub listening on port ${port}`);
 * ```
 */
export function createRemoteHub(config: StandaloneHubConfig = {}) {
	const authConfig = config.auth ?? { mode: 'none' as const };
	const preferredPort =
		config.port ?? Number.parseInt(process.env.PORT ?? '3913', 10);

	const dataDir = process.env.DATA_DIR ?? './data';
	const dbPath = config.dbPath ?? `${dataDir}/sync.db`;

	const storage = new BunSqliteUpdateLog(dbPath);

	// --- Build the Hono app ---

	const { auth, betterAuth } = createStandaloneAuth(authConfig);
	const app = factory.createApp();

	// CORS (skips WebSocket upgrades)
	app.use('*', corsMiddleware);

	// Health
	app.get('/', (c) =>
		c.json({ mode: 'hub', version: '0.1.0', runtime: 'standalone' }),
	);

	// Auth
	app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

	// OAuth discovery
	app.get('/.well-known/openid-configuration/auth', createOidcConfigHandler(auth));
	app.get(
		'/.well-known/oauth-authorization-server/auth',
		createOAuthMetadataHandler(auth),
	);

	// Auth guard for protected routes
	const authGuard = createAuthMiddleware(auth);
	app.use('/ai/*', authGuard);
	app.use('/proxy/*', authGuard);
	app.use('/rooms/*', authGuard);

	// AI chat + provider proxy
	app.post('/ai/chat', handleAiChat);
	app.all('/proxy/:provider/*', handleProxy);

	// Sync (WebSocket + HTTP)
	const { roomManager, shutdown } = mountSyncRoutes(app, {
		storage,
		...config.sync,
	});

	// --- Lifecycle ---

	let server: { port: number; stop(): void } | undefined;

	return {
		app,

		async start(): Promise<{ port: number }> {
			if (betterAuth) {
				await seedAdminIfNeeded(betterAuth);
			}

			server = Bun.serve({
				port: preferredPort,
				fetch: app.fetch,
				websocket,
			});

			return { port: server.port };
		},

		async stop(): Promise<void> {
			await shutdown();
			roomManager.destroy();
			storage.close();
			server?.stop();
		},
	};
}

/** Bun entry point shape for direct `bun run` usage. */
export { websocket };
