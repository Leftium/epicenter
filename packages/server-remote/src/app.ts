import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAuthMiddleware } from './auth/middleware';
import { handleAiChat } from './proxy/chat';
import { handleProxy } from './proxy/passthrough';
import type { SharedAppConfig, SharedEnv } from './types';

/**
 * Creates a Hono app with shared routes (health, auth, AI chat, provider proxy).
 *
 * Adapters (Cloudflare, standalone) call this and then mount their own
 * sync routes and any adapter-specific middleware.
 */
export function createSharedApp(config: SharedAppConfig) {
	const app = new Hono<SharedEnv>();

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
	app.get('/', (c) =>
		c.json({ mode: 'hub', version: '0.1.0', ...config.healthMeta }),
	);

	// --- Better Auth ---
	app.on(['GET', 'POST'], '/auth/*', (c) => {
		return config.auth.handler(c.req.raw);
	});

	// --- OAuth Discovery ---
	app.get('/.well-known/openid-configuration/auth', (c) =>
		oauthProviderOpenIdConfigMetadata(config.auth as never)(c.req.raw),
	);
	app.get('/.well-known/oauth-authorization-server/auth', (c) =>
		oauthProviderAuthServerMetadata(config.auth as never)(c.req.raw),
	);

	// --- Auth middleware for protected routes ---
	const authGuard = createAuthMiddleware(config.auth);
	app.use('/rooms/*', authGuard);
	app.use('/ai/*', authGuard);
	app.use('/proxy/*', authGuard);

	// --- AI Chat (SSE streaming) ---
	app.post('/ai/chat', handleAiChat);

	// --- Provider Proxy ---
	app.all('/proxy/:provider/*', handleProxy);

	return app;
}
