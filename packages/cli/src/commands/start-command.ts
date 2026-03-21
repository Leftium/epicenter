/**
 * `epicenter start [dir]` — long-lived sync daemon.
 *
 * Loads workspace config, auto-wires persistence + sync, stays alive.
 * This replaces the standalone `apps/runner` binary.
 */

import type { Argv, CommandModule } from 'yargs';
import { startDaemon } from '../runtime/start-daemon';

export function buildStartCommand(): CommandModule {
	return {
		command: 'start [dir]',
		describe: 'Start the sync daemon for a workspace directory',
		builder: (y: Argv) =>
			y
				.positional('dir', {
					type: 'string' as const,
					default: '.',
					describe:
						'Directory containing epicenter.config.ts (default: current directory)',
				})
				.option('server', {
					type: 'string' as const,
					describe:
						'Server URL (default: EPICENTER_SERVER_URL env or http://localhost:3913)',
				}),
		handler: async (argv) => {
			try {
				await startDaemon({
					dir: argv.dir as string | undefined,
					serverUrl: argv.server as string | undefined,
				});
				// Process stays alive — SIGINT/SIGTERM handlers manage shutdown
			} catch (err) {
				console.error(
					`Failed to start: ${err instanceof Error ? err.message : String(err)}`,
				);
				process.exit(1);
			}
		},
	};
}
