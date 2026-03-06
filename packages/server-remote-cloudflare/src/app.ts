import {
	type ApiKeyBindings,
	authMiddleware,
	corsMiddleware,
	handleAiChat,
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
	type Variables,
} from './shared';
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
