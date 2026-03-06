import {
	type ApiKeyBindings,
	corsMiddleware,
	createAuthMiddleware,
	createOAuthMetadataHandler,
	createOidcConfigHandler,
	handleAiChat,
	handleProxy,
	type Variables,
} from '@epicenter/server-remote';
import { Hono } from 'hono';
import { getAuth } from './auth';

export { YjsRoom } from './yjs-room';

type Env = { Bindings: ApiKeyBindings & Cloudflare.Env; Variables: Variables };

let app: Hono<Env> | null = null;

/**
 * Lazy init — defers postgres/Hyperdrive connection to first request.
 * Cloudflare Workers forbid async I/O at module scope, and Hyperdrive
 * connection strings are per-request, so auth (which wraps postgres)
 * must be created at request time.
 */
function getApp() {
	if (app) return app;

	const auth = getAuth();
	app = new Hono<Env>();

	// CORS (skips WebSocket upgrades)
	app.use('*', corsMiddleware);

	// Health
	app.get('/', (c) =>
		c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
	);

	// Auth
	app.on(['GET', 'POST'], '/auth/*', (c) => auth.handler(c.req.raw));

	// OAuth discovery
	app.get(
		'/.well-known/openid-configuration/auth',
		createOidcConfigHandler(auth),
	);
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

	// Sync rooms — forward to Durable Object
	app.all('/rooms/:room', async (c) => {
		const roomId = c.req.param('room');
		const id = c.env.YJS_ROOM.idFromName(roomId);
		const stub = c.env.YJS_ROOM.get(id);
		return stub.fetch(c.req.raw);
	});

	return app;
}

export default {
	fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext) {
		return getApp().fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Cloudflare.Env>;
