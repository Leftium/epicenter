import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
	oauthProviderOpenIdConfigMetadata,
	oauthProviderAuthServerMetadata,
} from '@better-auth/oauth-provider';
import { createAuth } from './auth/better-auth';
import { createAuthMiddleware } from './auth/middleware';
import { createMigrateHandler } from './auth/migrate';
import { createAiChatHandler } from './ai/chat';
import { createProxyHandler } from './proxy/handler';

export { YjsRoom } from './sync/yjs-room';

export type Bindings = {
	DATABASE_URL: string;
	YJS_ROOM: DurableObjectNamespace;
	SESSION_KV: KVNamespace;
	AUTH_SECRET: string;
	BASE_URL?: string; // e.g. https://api.epicenter.so — OAuth issuer
	OPENAI_API_KEY?: string;
	ANTHROPIC_API_KEY?: string;
	GEMINI_API_KEY?: string;
	GROK_API_KEY?: string;
};

export type Variables = {
	user: { id: string; name: string; email: string };
	session: { id: string; token: string };
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// --- CORS ---
// Skip CORS for WebSocket upgrades — Hono's CORS middleware modifies response
// headers, which conflicts with the immutable 101 WebSocket upgrade response
// returned from Durable Object stubs.
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
	c.json({ mode: 'hub', runtime: 'cloudflare', version: '0.1.0' }),
);

// --- Better Auth ---
// Use app.on() instead of app.mount() — mount() strips the base path before
// forwarding, which breaks Better Auth's internal routing when basePath is '/auth'.
app.on(['GET', 'POST'], '/auth/*', (c) => {
	return createAuth(c.env).handler(c.req.raw);
});

// --- OAuth Discovery (must be at root, not under /auth) ---
// Type assertion: createAuth() returns a generic Auth type that loses plugin-
// specific API methods from the cache. The oauthProvider plugin adds these at runtime.
app.get('/.well-known/openid-configuration', (c) =>
	oauthProviderOpenIdConfigMetadata(createAuth(c.env) as never)(c.req.raw),
);
app.get('/.well-known/oauth-authorization-server', (c) =>
	oauthProviderAuthServerMetadata(createAuth(c.env) as never)(c.req.raw),
);

// --- DB Migrations (protected, deploy-time only) ---
app.post('/migrate', createMigrateHandler());

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
app.post('/ai/chat', createAiChatHandler());

// --- Provider Proxy ---
app.all('/proxy/:provider/*', createProxyHandler());

export default app;
