/**
 * Headless Workspace Runner
 *
 * Loads epicenter.config.ts from a project folder, auto-wires persistence and sync
 * extensions for each workspace definition, and stays alive as a headless client
 * connected to the Epicenter server.
 *
 * Usage:
 *   bun run apps/runner -- /path/to/project
 *   bun run apps/runner -- .
 *   bun run apps/runner              # defaults to cwd
 *
 * Environment:
 *   EPICENTER_SERVER_URL  Server URL (default: ws://localhost:3913)
 *   EPICENTER_TOKEN       Auth token for authenticated sync servers
 */

import { join } from 'node:path';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
import { loadConfig } from './load-config';

// ─── Resolve target directory ──────────────────────────────────────────────

const targetDir = process.argv[2] ?? process.cwd();

// ─── Load config ───────────────────────────────────────────────────────────

const { configDir, definitions, clients } = await loadConfig(targetDir);

const serverUrl = process.env.EPICENTER_SERVER_URL ?? 'ws://localhost:3913';
const token = process.env.EPICENTER_TOKEN;

// ─── Wire extensions for raw definitions ───────────────────────────────────

const allClients: AnyWorkspaceClient[] = [...clients];

for (const definition of definitions) {
	const persistencePath = join(
		configDir,
		'.epicenter',
		'persistence',
		`${definition.id}.db`,
	);

	const client = createWorkspace(definition)
		.withExtension(
			'persistence',
			filesystemPersistence({ filePath: persistencePath }),
		)
		.withExtension(
			'sync',
			createSyncExtension({
				url: (id) => `${serverUrl}/workspaces/${id}`,
				...(token && { getToken: async () => token }),
			}),
		);

	allClients.push(client);
}

// ─── Wait for all clients to be ready ──────────────────────────────────────

await Promise.all(allClients.map((c) => c.whenReady));

// ─── Log status ────────────────────────────────────────────────────────────

const ids = allClients.map((c) => c.id);
console.log(`\u2713 Runner started \u2014 ${allClients.length} workspace(s)`);
console.log(`  Workspaces: ${ids.join(', ')}`);
console.log(`  Server: ${serverUrl}`);
console.log(`  Auth: ${token ? 'token provided' : 'none (open mode)'}`);
console.log(`  Config: ${configDir}`);
console.log('');
console.log('Press Ctrl+C to stop');

// ─── Graceful shutdown ─────────────────────────────────────────────────────

async function shutdown() {
	console.log('\nShutting down...');
	await Promise.all(allClients.map((c) => c.destroy()));
	console.log('✓ Graceful shutdown complete');
	process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
