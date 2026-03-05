import {
	createServerFactory,
	createSharedApp,
} from '@epicenter/server-remote';
import { getAuth } from './auth';

export { YjsRoom } from './yjs-room';

const factory = createServerFactory<Cloudflare.Env>();

let app: ReturnType<typeof factory.createApp> | null = null;

/**
 * Lazy init — defers postgres/Hyperdrive connection to first request.
 * Cloudflare Workers forbid async I/O at module scope, and Hyperdrive
 * connection strings are per-request, so auth (which wraps postgres)
 * must be created at request time.
 */
function getApp() {
	if (app) return app;

	const auth = getAuth();

	const { app: sharedApp, createAuthGuard } = createSharedApp({
		factory,
		auth,
		healthMeta: { runtime: 'cloudflare' },
	});

	app = factory.createApp();

	// Mount shared routes (health, auth, OAuth discovery, AI chat, proxy)
	app.route('/', sharedApp);

	// Auth middleware for rooms — must be on the parent app since /rooms/:room
	// is defined here, not in the shared sub-app.
	app.use('/rooms/*', createAuthGuard());

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
