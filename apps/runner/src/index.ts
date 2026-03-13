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
 * Subcommands:
 *   bun run apps/runner login --server https://api.epicenter.so [dir]
 *   bun run apps/runner logout [dir]
 *
 * Environment:
 *   EPICENTER_SERVER_URL  Server URL (default: ws://localhost:3913)
 *   EPICENTER_TOKEN       Auth token override (takes precedence over stored token)
 */

import { join, resolve } from 'node:path';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
import { login, logout, loadToken } from './auth';
import { loadConfig } from './load-config';


const args = process.argv.slice(2);
let targetDir: string;

switch (args[0]) {
	case 'login': {
		const serverIdx = args.indexOf('--server');
		if (serverIdx === -1 || !args[serverIdx + 1]) {
			console.error('Usage: runner login --server <url> [dir]');
			process.exit(1);
		}
		const server = args[serverIdx + 1]!;
		const remaining = args.filter((_, i) => i !== 0 && i !== serverIdx && i !== serverIdx + 1);
		const dir = remaining[0] ?? process.cwd();
		await login(server, resolve(dir));
		process.exit(0);
	}
	case 'logout': {
		const dir = args[1] ?? process.cwd();
		await logout(resolve(dir));
		process.exit(0);
	}
	default:
		targetDir = args[0] ?? process.cwd();
}



const { configDir, definitions, clients } = await loadConfig(targetDir);

const serverUrl = process.env.EPICENTER_SERVER_URL ?? 'ws://localhost:3913';

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
				getToken: () => loadToken(configDir),
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
const initialToken = await loadToken(configDir);
console.log(`  Auth: ${initialToken ? 'token loaded' : 'none (open mode)'}`);
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
