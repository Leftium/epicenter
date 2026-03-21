/**
 * Start the sync daemon — the core of `epicenter start [dir]`.
 *
 * Extracted from `apps/runner/src/index.ts` into a callable function so the
 * CLI's yargs command can invoke it without manual argv parsing.
 *
 * Lifecycle:
 * 1. Load `epicenter.config.ts` from the target directory
 * 2. Resolve auth token (env var → stored session → undefined)
 * 3. For each raw definition: auto-wire filesystem persistence + WebSocket sync
 * 4. For each pre-wired client: passthrough (already has extensions)
 * 5. Await `whenReady` on all clients
 * 6. Print status, stay alive
 * 7. SIGINT/SIGTERM → destroy all clients → exit
 */

import { join } from 'node:path';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { createWorkspace } from '@epicenter/workspace';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync';
import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
import { loadConfig } from '../config/load-config';
import { resolveServer, resolveToken } from '../auth/store';
import { resolveEpicenterHome } from '../util/paths';

export type StartDaemonOptions = {
	/** Directory containing epicenter.config.ts. Defaults to cwd. */
	dir?: string;
	/** Sync server URL. Resolved from: flag → env → stored session → ws://localhost:3913. */
	serverUrl?: string;
	/** Epicenter home directory (for auth store). Defaults to $EPICENTER_HOME or ~/.epicenter. */
	home?: string;
	/**
	 * Token resolver. Called on each WebSocket connect/reconnect.
	 * Defaults to: EPICENTER_TOKEN env → stored session → undefined.
	 */
	getToken?: () => Promise<string | undefined>;
};

/**
 * Start the sync daemon.
 *
 * Returns a cleanup function and the list of active clients.
 * The daemon stays alive until the returned `shutdown()` is called
 * or the process receives SIGINT/SIGTERM.
 */
export async function startDaemon(options: StartDaemonOptions = {}) {
	const targetDir = options.dir ?? process.cwd();
	const home = options.home ?? resolveEpicenterHome();

	// Resolve server: flag → env → stored session → default
	const serverUrl =
		options.serverUrl ??
		process.env.EPICENTER_SERVER_URL ??
		(await resolveServer(home)) ??
		'ws://localhost:3913';

	const { configDir, definitions, clients } = await loadConfig(targetDir);

	// Token resolver: custom → env → stored session for this server
	const getToken =
		options.getToken ??
		(() => resolveToken(home, serverUrl));

	// ─── Wire extensions for raw definitions ───────────────────────────────

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
					getToken: () => getToken(),
				}),
			);

		allClients.push(client);
	}

	// ─── Wait for all clients to be ready ──────────────────────────────────

	await Promise.all(allClients.map((c) => c.whenReady));

	// ─── Log status ────────────────────────────────────────────────────────

	const ids = allClients.map((c) => c.id);
	console.log(`✓ Runner started — ${allClients.length} workspace(s)`);
	console.log(`  Workspaces: ${ids.join(', ')}`);
	console.log(`  Server: ${serverUrl}`);
	const initialToken = await getToken();
	console.log(`  Auth: ${initialToken ? 'token loaded' : 'none (open mode)'}`);
	console.log(`  Config: ${configDir}`);
	console.log('');
	console.log('Press Ctrl+C to stop');

	// ─── Graceful shutdown ─────────────────────────────────────────────────

	async function shutdown() {
		console.log('\nShutting down...');
		await Promise.all(allClients.map((c) => c.destroy()));
		console.log('✓ Graceful shutdown complete');
	}

	const sigintHandler = async () => {
		await shutdown();
		process.exit(0);
	};

	process.on('SIGINT', sigintHandler);
	process.on('SIGTERM', sigintHandler);

	return {
		/** All active workspace clients. */
		clients: allClients,
		/** Resolved config directory. */
		configDir,
		/** Gracefully destroy all clients and clean up signal handlers. */
		async shutdown() {
			process.off('SIGINT', sigintHandler);
			process.off('SIGTERM', sigintHandler);
			await shutdown();
		},
	};
}
