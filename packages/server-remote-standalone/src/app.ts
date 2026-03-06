import {
	oauthProvider,
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';
import { cors } from 'hono/cors';
import { createFactory } from 'hono/factory';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { handleAiChat } from './ai-chat';
import { BunSqliteUpdateLog } from './storage';
import { mountSyncRoutes, websocket } from './sync-adapter';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const trustedClients = [
	{
		clientId: 'epicenter-desktop',
		name: 'Epicenter Desktop',
		type: 'native',
		redirectUrls: ['tauri://localhost/auth/callback'],
		skipConsent: true,
		metadata: {},
	},
	{
		clientId: 'epicenter-mobile',
		name: 'Epicenter Mobile',
		type: 'native',
		redirectUrls: ['epicenter://auth/callback'],
		skipConsent: true,
		metadata: {},
	},
] as const;

export type StandaloneAuthConfig =
	| { mode: 'none' }
	| { mode: 'token'; token: string }
	| {
			mode: 'betterAuth';
			/** Database connection (bun:sqlite Database or pg Pool). */
			database: unknown;
			/** Secret for signing session tokens. Falls back to BETTER_AUTH_SECRET or AUTH_SECRET env. */
			secret?: string;
			/** Trusted origins for CORS/CSRF validation. */
			trustedOrigins?: string[];
			/** Social OAuth provider credentials. */
			socialProviders?: Record<
				string,
				{ clientId: string; clientSecret: string }
			>;
	  };

function createBetterAuthInstance(config: {
	database: unknown;
	secret?: string;
	trustedOrigins?: string[];
	socialProviders?: Record<string, { clientId: string; clientSecret: string }>;
}) {
	const auth = betterAuth({
		basePath: '/auth',
		emailAndPassword: { enabled: true },
		database: config.database as Parameters<typeof betterAuth>[0]['database'],
		secret: config.secret,
		trustedOrigins: config.trustedOrigins,
		socialProviders: config.socialProviders,
		plugins: [
			bearer(),
			jwt(),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				allowDynamicClientRegistration: true,
				trustedClients: [...trustedClients],
			}),
		],
	});

	return { auth, betterAuth: auth };
}

/** Inferred auth type from a real Better Auth instance with all plugins. */
export type StandaloneAuth = ReturnType<
	typeof createBetterAuthInstance
>['auth'];

function createNoneAuth() {
	return {
		handler: () => new Response('Not Found', { status: 404 }),
		api: {
			getSession: async () => ({
				user: { id: 'anonymous', name: 'Anonymous', email: '' },
				session: { id: 'anonymous' },
			}),
		},
	} as unknown as StandaloneAuth;
}

function createTokenAuth(token: string) {
	const handler = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);

		if (url.pathname === '/auth/get-session' && request.method === 'GET') {
			const authHeader = request.headers.get('authorization');
			const bearerToken = authHeader?.startsWith('Bearer ')
				? authHeader.slice(7)
				: null;

			if (bearerToken === token) {
				return Response.json({
					user: { id: 'token-user', name: 'Token User' },
				});
			}
			return Response.json({ error: 'Unauthorized' }, { status: 401 });
		}

		return new Response('Not Found', { status: 404 });
	};

	return {
		handler,
		api: {
			getSession: async ({ headers }: { headers: Headers }) => {
				const authHeader = headers.get('authorization');
				const bearerToken = authHeader?.startsWith('Bearer ')
					? authHeader.slice(7)
					: null;

				if (bearerToken === token) {
					return {
						user: { id: 'token-user', name: 'Token User', email: '' },
						session: { id: 'token-session' },
					};
				}
				return null;
			},
		},
	} as unknown as StandaloneAuth;
}

type AdminSeeder = {
	api: {
		signUpEmail: (opts: {
			body: { email: string; password: string; name: string };
		}) => Promise<unknown>;
	};
};

function createStandaloneAuth(config: StandaloneAuthConfig): {
	auth: StandaloneAuth;
	betterAuth?: AdminSeeder;
} {
	switch (config.mode) {
		case 'none':
			return { auth: createNoneAuth() };
		case 'token':
			return { auth: createTokenAuth(config.token) };
		case 'betterAuth':
			return createBetterAuthInstance(config);
	}
}

async function seedAdminIfNeeded(auth: AdminSeeder) {
	const email = process.env.ADMIN_EMAIL;
	const password = process.env.ADMIN_PASSWORD;
	if (!email || !password) return;

	try {
		await auth.api.signUpEmail({ body: { email, password, name: 'Admin' } });
	} catch {
		// Already exists or signup disabled — fine
	}
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ApiKeyBindings = {
	OPENAI_API_KEY?: string;
	ANTHROPIC_API_KEY?: string;
	GEMINI_API_KEY?: string;
	GROK_API_KEY?: string;
};

type Session = StandaloneAuth['$Infer']['Session'];

type Env = {
	Bindings: ApiKeyBindings;
	Variables: {
		user: Session['user'];
		session: Session['session'];
	};
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
	const { auth, betterAuth } = createStandaloneAuth(authConfig);

	// --- Build the Hono app ---

	const factory = createFactory<Env>({
		initApp: (app) => {
			// CORS — skip WebSocket upgrades (101 response headers are immutable)
			app.use('*', async (c, next) => {
				if (c.req.header('upgrade') === 'websocket') return next();
				return cors({
					origin: (origin) => origin,
					credentials: true,
					allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
					allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
				})(c, next);
			});
		},
	});

	const app = factory.createApp();

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

	// Auth guard — references `auth` from closure, no context middleware needed
	const authGuard = factory.createMiddleware(async (c, next) => {
		const wsToken = c.req.query('token');
		const headers = wsToken
			? new Headers({ authorization: `Bearer ${wsToken}` })
			: c.req.raw.headers;

		const result = await auth.api.getSession({ headers });
		if (!result) return c.json(AuthError.Unauthorized(), 401);

		c.set('user', result.user);
		c.set('session', result.session);
		await next();
	});
	app.use('/ai/*', authGuard);
	app.use('/rooms/*', authGuard);

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
