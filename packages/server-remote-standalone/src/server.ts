import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import {
	PROVIDER_ENV_VARS,
	type SupportedProvider,
} from '@epicenter/sync-core';
import type { Auth } from 'better-auth';
import type { MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import { createFactory } from 'hono/factory';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { handleAiChat } from './ai-chat';
import type { StandaloneAuthConfig } from './auth';
import { createStandaloneAuth, seedAdminIfNeeded } from './auth';
import { BunSqliteUpdateLog } from './storage';
import { mountSyncRoutes, websocket } from './sync-adapter';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApiKeyBindings = {
	[K in SupportedProvider as (typeof PROVIDER_ENV_VARS)[K]]?: string;
};

type SessionResult = {
	user: { id: string; name: string; email: string; [key: string]: unknown };
	session: { id: string; [key: string]: unknown };
};

/** Auth instance with oauth-provider plugin APIs preserved. */
type AuthWithOAuth = Auth & {
	api: {
		getOpenIdConfig: (...args: unknown[]) => unknown;
		getOAuthServerConfig: (...args: unknown[]) => unknown;
	};
};

type Variables = {
	auth: AuthWithOAuth;
	user: SessionResult['user'];
	session: SessionResult['session'];
};

type Env = {
	Bindings: ApiKeyBindings;
	Variables: Variables;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const AuthError = defineErrors({
	Unauthorized: () => ({
		message: 'Unauthorized',
	}),
});
type AuthError = InferErrors<typeof AuthError>;

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * CORS middleware that skips WebSocket upgrades.
 *
 * Hono's CORS middleware modifies response headers, which conflicts with
 * the immutable 101 WebSocket upgrade response.
 */
const corsMiddleware: MiddlewareHandler<Env> = async (c, next) => {
	if (c.req.header('upgrade') === 'websocket') return next();
	return cors({
		origin: (origin) => origin,
		credentials: true,
		allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	})(c, next);
};

/** Auth middleware that validates sessions via Better Auth on the context. */
const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
	const wsToken = c.req.query('token');
	const headers = wsToken
		? new Headers({ authorization: `Bearer ${wsToken}` })
		: c.req.raw.headers;

	const result = await c.var.auth.api.getSession({ headers });
	if (!result) return c.json(AuthError.Unauthorized(), 401);

	c.set('user', result.user);
	c.set('session', result.session);
	await next();
};

const factory = createFactory<Env>();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

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
	app.use('*', async (c, next) => {
		c.set('auth', auth);
		await next();
	});

	// Health
	app.get('/', (c) =>
		c.json({ mode: 'hub', version: '0.1.0', runtime: 'standalone' }),
	);

	// Auth
	app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

	// OAuth discovery
	const oidcConfig = oauthProviderOpenIdConfigMetadata(auth);
	const oauthMeta = oauthProviderAuthServerMetadata(auth);
	app.get('/.well-known/openid-configuration/auth', (c) =>
		oidcConfig(c.req.raw),
	);
	app.get('/.well-known/oauth-authorization-server/auth', (c) =>
		oauthMeta(c.req.raw),
	);

	// Auth guard for protected routes
	for (const path of ['/ai/*', '/rooms/*']) {
		app.use(path, authMiddleware);
	}

	// AI chat
	app.post('/ai/chat', handleAiChat);

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
