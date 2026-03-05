import { createSharedApp } from '@epicenter/server-remote';
import { getAuth } from './auth';

let app: ReturnType<typeof createSharedApp> | null = null;

/** Lazy init — avoids global-scope I/O in Cloudflare Workers. */
function getApp() {
	if (app) return app;

	app = createSharedApp({
		auth: getAuth(),
		healthMeta: { runtime: 'cloudflare' },
	});

	// --- Sync rooms (forward to Durable Object) ---
	// This is the only Cloudflare-specific route — all other routes are shared.
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
