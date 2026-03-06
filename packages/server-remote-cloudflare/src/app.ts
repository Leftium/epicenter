import {
	oauthProvider,
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import {
	PROVIDER_ENV_VARS,
	type SupportedProvider,
} from '@epicenter/sync-core';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle } from 'drizzle-orm/postgres-js';
import { cors } from 'hono/cors';
import { createFactory } from 'hono/factory';
import postgres from 'postgres';
import { handleAiChat } from './ai-chat';
import * as schema from './db/schema';

export { YjsRoom } from './yjs-room';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Env = {
	Bindings: {
		[K in SupportedProvider as (typeof PROVIDER_ENV_VARS)[K]]?: string;
	} & Cloudflare.Env;
	Variables: {
		auth: ReturnType<typeof createAuth>;
		user: { id: string; name: string; email: string; [key: string]: unknown };
		session: { id: string; [key: string]: unknown };
	};
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Creates a fresh auth instance per-request. Hyperdrive clients must not be cached across requests. */
function createAuth(env: Cloudflare.Env) {
	const sql = postgres(env.HYPERDRIVE.connectionString);
	const db = drizzle(sql, { schema });

	return betterAuth({
		basePath: '/auth',
		emailAndPassword: { enabled: true },
		database: drizzleAdapter(db, { provider: 'pg' }),
		baseURL: env.BETTER_AUTH_URL,
		secret: env.BETTER_AUTH_SECRET,
		plugins: [
			bearer(),
			jwt(),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				allowDynamicClientRegistration: true,
				trustedClients: [
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
				],
			}),
		],
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			storeSessionInDatabase: true,
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5,
				strategy: 'jwe',
			},
		},
		advanced: {
			crossSubDomainCookies: {
				enabled: true,
				domain: 'epicenter.so',
			},
		},
		trustedOrigins: [
			'https://*.epicenter.so',
			'https://epicenter.so',
			'tauri://localhost',
		],
		secondaryStorage: {
			get: (key: string) => env.SESSION_KV.get(key),
			set: (key: string, value: string, ttl?: number) =>
				env.SESSION_KV.put(key, value, {
					expirationTtl: ttl ?? 60 * 5,
				}),
			delete: (key: string) => env.SESSION_KV.delete(key),
		},
	});
}

// ---------------------------------------------------------------------------
// Factory & App
// ---------------------------------------------------------------------------

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
		// Auth instance per-request (Hyperdrive clients must not be cached)
		app.use('*', async (c, next) => {
			c.set('auth', createAuth(c.env));
			await next();
		});
	},
});

const app = factory.createApp();

// Health
app.get('/', (c) =>
	c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth
app.on(['GET', 'POST'], '/auth/*', (c) => c.var.auth.handler(c.req.raw));

// OAuth discovery
app.get('/.well-known/openid-configuration/auth', (c) =>
	oauthProviderOpenIdConfigMetadata(c.var.auth)(c.req.raw),
);
app.get('/.well-known/oauth-authorization-server/auth', (c) =>
	oauthProviderAuthServerMetadata(c.var.auth)(c.req.raw),
);

// Auth guard for protected routes
const authGuard = factory.createMiddleware(async (c, next) => {
	const wsToken = c.req.query('token');
	const headers = wsToken
		? new Headers({ authorization: `Bearer ${wsToken}` })
		: c.req.raw.headers;

	const result = await c.var.auth.api.getSession({ headers });
	if (!result) return c.json({ error: 'Unauthorized' }, 401);

	c.set('user', result.user);
	c.set('session', result.session);
	await next();
});
app.use('/ai/*', authGuard);
app.use('/rooms/*', authGuard);

// AI chat
app.post('/ai/chat', handleAiChat);

// Sync rooms — forward to Durable Object
app.all('/rooms/:room', async (c) => {
	const roomId = c.req.param('room');
	const id = c.env.YJS_ROOM.idFromName(roomId);
	const stub = c.env.YJS_ROOM.get(id);
	return stub.fetch(c.req.raw);
});

export default app;
