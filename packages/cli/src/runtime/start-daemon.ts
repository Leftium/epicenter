/**
 * Start the sync daemon — the core of `epicenter start [dir]`.
 *
 * Exposed as a callable runtime so the CLI command can invoke it without
 * manual argv parsing.
 *
 * Lifecycle:
 * 1. Load `epicenter.config.ts` from the target directory
 * 2. Await `whenReady` on all clients
 * 3. Print status, stay alive
 * 4. SIGINT/SIGTERM → destroy all clients → exit
 */

import { loadConfig } from '../load-config';

export type StartDaemonOptions = {
	/** Directory containing epicenter.config.ts. Defaults to cwd. */
	dir?: string;
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
	const { configDir, clients } = await loadConfig(targetDir);

	await Promise.all(clients.map((c) => c.whenReady));

	// ─── Log status ────────────────────────────────────────────────────────

	const ids = clients.map((c) => c.id);
	console.log(`✓ Started — ${clients.length} workspace(s)`);
	console.log(`  Workspaces: ${ids.join(', ')}`);
	console.log(`  Config: ${configDir}`);
	console.log('');
	console.log('Press Ctrl+C to stop');

	// ─── Graceful shutdown ─────────────────────────────────────────────────

	async function shutdown() {
		console.log('\nShutting down...');
		await Promise.all(clients.map((c) => c.dispose()));
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
		clients,
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
