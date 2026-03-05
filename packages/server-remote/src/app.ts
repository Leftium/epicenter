import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { cors } from 'hono/cors';
import { createFactory, type Factory } from 'hono/factory';
import { createAuthMiddleware } from './auth/middleware';
import { handleAiChat } from './proxy/chat';
import { handleProxy } from './proxy/passthrough';
import type { AuthInstance, ServerEnv, SharedEnv } from './types';

/**
 * Creates a Hono factory with the shared env types merged with optional
 * extra bindings. Just wraps `createFactory` — nothing else.
 *
 * ```ts
 * const factory = createServerFactory<Cloudflare.Env>();
 * const app = factory.createApp(); // Hono<{ Bindings: ApiKeyBindings & Cloudflare.Env; Variables }>
 * ```
 */
export function createServerFactory<
	TExtraBindings extends object = {},
>() {
	return createFactory<ServerEnv<TExtraBindings>>();
}

/**
 * Creates a Hono sub-app with shared routes (health, auth, AI chat, provider proxy)
 * and a pre-typed auth guard for consumer routes like `/rooms/*`.
 *
 * ```ts
 * const factory = createServerFactory<Cloudflare.Env>();
 * const { app: sharedApp, createAuthGuard } = createSharedApp({
 *   factory,
 *   auth: getAuth(),
 *   healthMeta: { runtime: 'cloudflare' },
 * });
 * const app = factory.createApp();
 * app.route('/', sharedApp);
 * app.use('/rooms/*', createAuthGuard());
 * ```
 */
export function createSharedApp<E extends SharedEnv>({
	factory,
	auth,
	healthMeta,
}: {
	factory: Factory<E>;
	auth: AuthInstance;
	healthMeta?: Record<string, unknown>;
}) {
	const app = factory.createApp();

	// --- CORS ---
	// Skip CORS for WebSocket upgrades — Hono's CORS middleware modifies response
	// headers, which conflicts with the immutable 101 WebSocket upgrade response.
	app.use('*', async (c, next) => {
		if (c.req.header('upgrade') === 'websocket') return next();
		return cors({
			origin: (origin) => origin,
			credentials: true,
			allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
			allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
		})(c, next);
	});

	// --- Health / Discovery ---
	app.get('/', (c) => c.json({ mode: 'hub', version: '0.1.0', ...healthMeta }));

	// --- Better Auth ---
	app.on(['GET', 'POST'], '/auth/*', (c) => {
		return auth.handler(c.req.raw);
	});

	// --- OAuth Discovery ---
	app.get('/.well-known/openid-configuration/auth', (c) =>
		oauthProviderOpenIdConfigMetadata(auth as never)(c.req.raw),
	);
	app.get('/.well-known/oauth-authorization-server/auth', (c) =>
		oauthProviderAuthServerMetadata(auth as never)(c.req.raw),
	);

	// --- Auth middleware for routes owned by this sub-app ---
	const authGuard = createAuthMiddleware(auth);
	app.use('/ai/*', authGuard);
	app.use('/proxy/*', authGuard);

	// --- AI Chat (SSE streaming) ---
	app.post('/ai/chat', handleAiChat);

	// --- Provider Proxy ---
	app.all('/proxy/:provider/*', handleProxy);

	return {
		app,
		createAuthGuard() {
			return createAuthMiddleware(auth);
		},
	};
}
