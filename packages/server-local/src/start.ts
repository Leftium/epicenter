/**
 * Sidecar entry point.
 *
 * Starts the Epicenter sidecar — the per-device data and execution plane.
 *
 * Usage:
 *   bun packages/server-local/src/start.ts
 *   PORT=4000 bun packages/server-local/src/start.ts
 */

import { createSidecar } from './sidecar';

const server = createSidecar({
	clients: [],
	sync: {
		onRoomCreated: (roomId) => console.log(`[Sync] Room created: ${roomId}`),
		onRoomEvicted: (roomId) => console.log(`[Sync] Room evicted: ${roomId}`),
	},
});

const { port } = server.start();

console.log(`Epicenter SIDECAR running on http://localhost:${port}`);
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
