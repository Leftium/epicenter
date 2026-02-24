/**
 * Local server entry point.
 *
 * Starts the Epicenter local server — the per-device sidecar that provides:
 * - Sync relay (local) — fast sub-ms WebSocket sync between webview and Y.Doc
 * - Workspace API — RESTful CRUD for workspace tables and actions
 *
 * The local server does NOT handle AI — all AI goes through the hub.
 *
 * Usage:
 *   bun packages/server/src/start-local.ts
 *   PORT=4000 bun packages/server/src/start-local.ts
 */

import { createLocalServer } from './local';

const port = Number.parseInt(process.env.PORT ?? '3913', 10);

const server = createLocalServer({
	clients: [],
	port,
	sync: {
		onRoomCreated: (roomId) => console.log(`[Sync] Room created: ${roomId}`),
		onRoomEvicted: (roomId) => console.log(`[Sync] Room evicted: ${roomId}`),
	},
});

server.start();

console.log(`Epicenter LOCAL server running on http://localhost:${port}`);
console.log(`  Sync:    ws://localhost:${port}/rooms/{room}`);
console.log(`  (No AI — all AI goes through the hub)`);

process.on('SIGINT', async () => {
	console.log('\nShutting down...');
	await server.stop();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await server.stop();
	process.exit(0);
});
