/**
 * `epicenter start [dir]` — long-lived workspace daemon.
 *
 * Loads workspace config, waits for all clients to be ready, stays alive.
 */

import type { Argv, CommandModule } from 'yargs';
import { startDaemon } from '../runtime/start-daemon';

export function buildStartCommand(): CommandModule {
	return {
		command: 'start [dir]',
		describe: 'Start the workspace daemon for a directory',
		builder: (y: Argv) =>
			y.positional('dir', {
				type: 'string' as const,
				default: '.',
				describe:
					'Directory containing epicenter.config.ts (default: current directory)',
			}),
		handler: async (argv) => {
			try {
				await startDaemon({
					dir: argv.dir as string | undefined,
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
