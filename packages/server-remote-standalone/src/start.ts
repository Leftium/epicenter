/**
 * Standalone hub entry point.
 *
 * Usage:
 *   bun packages/server-remote-standalone/src/start.ts
 *   AUTH_TOKEN=secret bun packages/server-remote-standalone/src/start.ts
 *   PORT=4000 bun packages/server-remote-standalone/src/start.ts
 */

import { mkdirSync } from 'node:fs';
import type { StandaloneAuthConfig } from './auth';
import { createRemoteHub } from './server';

function resolveAuthConfig(): StandaloneAuthConfig {
	if (process.env.AUTH_TOKEN) {
		return { mode: 'token', token: process.env.AUTH_TOKEN };
	}
	// Could add betterAuth mode detection here via DATABASE_URL, etc.
	return { mode: 'none' };
}

// Ensure the data directory exists for SQLite persistence.
const dataDir = process.env.DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });

const hub = createRemoteHub({
	auth: resolveAuthConfig(),
	sync: {
		onRoomCreated: (roomId) => console.log(`[Sync] Room created: ${roomId}`),
		onRoomEvicted: (roomId) => console.log(`[Sync] Room evicted: ${roomId}`),
	},
});

const { port } = await hub.start();

console.log(`Epicenter Hub (standalone) running on http://localhost:${port}`);
console.log(`  Sync:  ws://localhost:${port}/rooms/{room}`);
console.log(`  AI:    POST http://localhost:${port}/ai/chat`);
console.log(`  Proxy: ALL http://localhost:${port}/proxy/{provider}/*`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, async () => {
		console.log('\nShutting down...');
		await hub.stop();
		process.exit(0);
	});
}
