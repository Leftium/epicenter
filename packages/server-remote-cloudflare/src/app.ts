import { createSharedApp } from '@epicenter/server-remote';
import { auth } from './auth';

const app = createSharedApp({
	auth,
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

export default app;
