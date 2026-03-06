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
import { createFactory } from 'hono/factory';
import { createAuth } from './auth';

export { YjsRoom } from './yjs-room';

type Env = { Bindings: ApiKeyBindings & Cloudflare.Env; Variables: Variables };

const factory = createFactory<Env>({
	initApp: (app) => {
		app.use('*', corsMiddleware);
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
	createOidcConfigHandler(c.var.auth)({ req: { raw: c.req.raw } }),
);
app.get('/.well-known/oauth-authorization-server/auth', (c) =>
	createOAuthMetadataHandler(c.var.auth)({ req: { raw: c.req.raw } }),
);

// Auth guard for protected routes
app.use('/ai/*', async (c, next) => {
	const guard = createAuthMiddleware(c.var.auth);
	return guard(c as never, next);
});
app.use('/proxy/*', async (c, next) => {
	const guard = createAuthMiddleware(c.var.auth);
	return guard(c as never, next);
});
app.use('/rooms/*', async (c, next) => {
	const guard = createAuthMiddleware(c.var.auth);
	return guard(c as never, next);
});

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

export default app;
