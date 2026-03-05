import {
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { cors } from 'hono/cors';
import { createAiChatHandler } from './ai/chat';
import { createAuth } from './auth/better-auth';
import { createAuthMiddleware } from './auth/middleware';
import { factory } from './factory';
import { createProxyHandler } from './proxy/handler';

const app = factory.createApp();

// --- Services middleware ---
// Constructs auth per-request from env bindings and stashes it in c.var.
// No module-level cache — fresh instance per request, per Better Auth's
// serverless recommendation.
const authService = factory.createMiddleware(async (c, next) => {
	c.set('auth', createAuth(c.env));
	return next();
});
app.use('*', authService);

// --- CORS ---
// Skip CORS for WebSocket upgrades — Hono's CORS middleware modifies response
// headers, which conflicts with the immutable 101 WebSocket upgrade response
// returned from Durable Object stubs.
const corsMiddleware = factory.createMiddleware(async (c, next) => {
	if (c.req.header('upgrade') === 'websocket') return next();
	return cors({
		origin: (origin) => origin,
		credentials: true,
		allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	})(c, next);
});
app.use('*', corsMiddleware);

// --- Health / Discovery ---
app.get('/', (c) =>
	c.json({ mode: 'hub', runtime: 'cloudflare', version: '0.1.0' }),
);

// --- Better Auth ---
// Use app.on() instead of app.mount() — mount() strips the base path before
// forwarding, which breaks Better Auth's internal routing when basePath is '/auth'.
app.on(['GET', 'POST'], '/auth/*', (c) => {
	return c.var.auth.handler(c.req.raw);
});

// --- OAuth Discovery (must be at root, not under /auth) ---
// Type assertion: createAuth() returns a generic Auth type that loses plugin-
// specific API methods from the cache. The oauthProvider plugin adds these at runtime.
app.get('/.well-known/openid-configuration', (c) =>
	oauthProviderOpenIdConfigMetadata(c.var.auth as never)(c.req.raw),
);
app.get('/.well-known/oauth-authorization-server', (c) =>
	oauthProviderAuthServerMetadata(c.var.auth as never)(c.req.raw),
);

// --- Auth middleware for protected routes ---
const authGuard = createAuthMiddleware();
app.use('/rooms/*', authGuard);
app.use('/ai/*', authGuard);
app.use('/proxy/*', authGuard);

// --- Sync rooms (forward to Durable Object) ---
app.all('/rooms/:room', async (c) => {
	const roomId = c.req.param('room');
	const id = c.env.YJS_ROOM.idFromName(roomId);
	const stub = c.env.YJS_ROOM.get(id);
	return stub.fetch(c.req.raw);
});

// --- AI Chat (SSE streaming) ---
app.post('/ai/chat', ...createAiChatHandler());

// --- Provider Proxy ---
app.all('/proxy/:provider/*', ...createProxyHandler());

export default app;
