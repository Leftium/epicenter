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
import { createAuth } from './auth';

export { YjsRoom } from './yjs-room';

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

export type Variables = {
	auth: AuthWithOAuth;
	user: SessionResult['user'];
	session: SessionResult['session'];
};

type Env = { Bindings: ApiKeyBindings & Cloudflare.Env; Variables: Variables };

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

const factory = createFactory<Env>({
	initApp: (app) => {
		app.use('*', corsMiddleware);
		app.use('*', async (c, next) => {
			c.set('auth', createAuth(c.env));
			await next();
		});
	},
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

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
for (const path of ['/ai/*', '/rooms/*']) {
	app.use(path, authMiddleware);
}

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
