import { createSharedApp } from '@epicenter/server-remote';
import { getAuth } from './auth';

export { YjsRoom } from './yjs-room';

let app: ReturnType<typeof createSharedApp> | null = null;

/**
 * Lazy init — defers postgres/Hyperdrive connection to first request.
 * Cloudflare Workers forbid async I/O at module scope, and Hyperdrive
 * connection strings are per-request, so auth (which wraps postgres)
 * must be created at request time.
 */
function getApp() {
	if (app) return app;

	app = createSharedApp({
		auth: getAuth(),
		healthMeta: { runtime: 'cloudflare' },
	});

	app.all('/rooms/:room', async (c) => {
		const roomId = c.req.param('room');
		const env = c.env as unknown as Cloudflare.Env;
		const id = env.YJS_ROOM.idFromName(roomId);
		const stub = env.YJS_ROOM.get(id);
		return stub.fetch(c.req.raw);
	});

	return app;
}

export default {
	fetch(request: Request, env: unknown, ctx: ExecutionContext) {
		return getApp().fetch(request, env as Record<string, unknown>, ctx);
	},
} satisfies ExportedHandler;
