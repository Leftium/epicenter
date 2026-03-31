/**
 * Start the sync daemon — the core of `epicenter start [dir]`.
 *
 * Exposed as a callable runtime so the CLI command can invoke it without
 * manual argv parsing.
 *
 * Lifecycle:
 * 1. Load `epicenter.config.ts` from the target directory
 * 2. Await `whenReady` on all clients
 * 3. Print status (workspaces, extensions), stay alive
 * 4. SIGINT/SIGTERM → destroy all clients → exit
 */

import { loadConfig } from '../load-config';

export type StartDaemonOptions = {
	/** Directory containing epicenter.config.ts. Defaults to cwd. */
	dir?: string;
	/** Enable periodic heartbeat logging. */
	verbose?: boolean;
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

	console.log(`✓ Started — ${clients.length} workspace(s)`);
	console.log(`  Config: ${configDir}`);

	for (const client of clients) {
		const extensionNames = Object.keys(client.extensions ?? {});
		const extLabel =
			extensionNames.length > 0
				? extensionNames.join(', ')
				: '(none)';
		console.log(`  ${client.id}: extensions=[${extLabel}]`);
	}

	console.log('');
	console.log('Press Ctrl+C to stop');

	// ─── Verbose heartbeat ────────────────────────────────────────────────

	let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
	if (options.verbose) {
		heartbeatInterval = setInterval(() => {
			const uptime = process.uptime();
			const hours = Math.floor(uptime / 3600);
			const minutes = Math.floor((uptime % 3600) / 60);
			const seconds = Math.floor(uptime % 60);
			console.log(
				`  ♥ alive — ${hours}h ${minutes}m ${seconds}s — ${clients.length} workspace(s)`,
			);
		}, 30_000);
	}

	// ─── Graceful shutdown ─────────────────────────────────────────────────

	async function shutdown() {
		if (heartbeatInterval) clearInterval(heartbeatInterval);
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
