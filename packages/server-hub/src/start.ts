/**
 * Hub server entry point.
 *
 * Starts the Epicenter hub — the sync and identity plane that provides:
 * - Sync relay (primary) — all devices sync through the hub
 * - AI streaming — all providers via SSE
 * - AI proxy — env var API keys, never leave the hub
 * - Better Auth — session-based authentication
 *
 * Usage:
 *   bun packages/server-hub/src/start.ts
 *   PORT=4000 bun packages/server-hub/src/start.ts
 */

import { createHub } from './hub';

const server = createHub({
	sync: {
		onRoomCreated: (roomId) => console.log(`[Sync] Room created: ${roomId}`),
		onRoomEvicted: (roomId) => console.log(`[Sync] Room evicted: ${roomId}`),
	},
});

const { port } = server.start();

console.log(`Epicenter HUB server running on http://localhost:${port}`);
console.log(`  Sync:    ws://localhost:${port}/rooms/{room}`);
console.log(`  AI:      POST http://localhost:${port}/ai/chat`);

process.on('SIGINT', async () => {
	console.log('\nShutting down...');
	await server.stop();
	process.exit(0);
});

process.on('SIGTERM', async () => {
	await server.stop();
	process.exit(0);
});
