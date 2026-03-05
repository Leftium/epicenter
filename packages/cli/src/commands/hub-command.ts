import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteHub } from '@epicenter/server-remote';
import type { Argv, CommandModule } from 'yargs';

const DEFAULT_HUB_PORT = 3914;

/**
 * Build the top-level `hub` command group for managing the Epicenter hub.
 * @param home - Path to the Epicenter home directory (used for PID file storage).
 * @returns A yargs CommandModule with start, status, and stop subcommands.
 */
export function buildHubCommand(home: string): CommandModule {
	return {
		command: 'hub <subcommand>',
		describe: 'Manage the Epicenter hub',
		builder: (y: Argv) =>
			y
				.command(buildHubStartCommand(home))
				.command(buildHubStatusCommand())
				.command(buildHubStopCommand(home))
				.demandCommand(1, 'Specify a subcommand: start, status, stop')
				.strict(),
		handler: () => {},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// hub start
// ═══════════════════════════════════════════════════════════════════════════

function buildHubStartCommand(home: string) {
	return {
		command: 'start',
		describe: 'Start the Epicenter hub',
		builder: (y: Argv) =>
			y.option('port', {
				type: 'number' as const,
				default: DEFAULT_HUB_PORT,
				description: 'Port to run the server on',
			}),
		handler: async (argv: { port: number }) => {
			const server = createRemoteHub({ port: argv.port });
			const { port } = await server.start();

			console.log(`\nEpicenter hub on http://localhost:${port}`);
			console.log(`API docs: http://localhost:${port}/openapi\n`);

			// Write PID file so `hub stop` can signal this process
			const pidFile = join(home, 'hub.pid');
			await writeFile(pidFile, String(process.pid), 'utf8');

			const shutdown = async () => {
				await server.stop();
				process.exit(0);
			};
			process.on('SIGINT', shutdown);
			process.on('SIGTERM', shutdown);

			await new Promise(() => {});
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// hub status
// ═══════════════════════════════════════════════════════════════════════════

function buildHubStatusCommand() {
	return {
		command: 'status',
		describe: 'Show the status of the Epicenter hub',
		builder: (y: Argv) =>
			y.option('url', {
				type: 'string' as const,
				default: `http://localhost:${DEFAULT_HUB_PORT}`,
				description: 'URL of the hub',
			}),
		handler: async (argv: { url: string }) => {
			let response: Response;
			try {
				response = await fetch(argv.url);
			} catch {
				console.error(
					`No Epicenter hub running at ${argv.url}.\n` +
						`Start one with: epicenter hub start`,
				);
				process.exitCode = 1;
				return;
			}

			if (!response.ok) {
				console.error(
					`Server responded with ${response.status} ${response.statusText}`,
				);
				process.exitCode = 1;
				return;
			}

			const info = (await response.json()) as {
				name?: string;
				version?: string;
				mode?: string;
			};

			console.log(
				`Server: ${info.name ?? 'Epicenter Hub'} v${info.version ?? 'unknown'}`,
			);
			console.log(`Mode:   ${info.mode ?? 'unknown'}`);
			console.log(`URL:    ${argv.url}`);
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// hub stop
// ═══════════════════════════════════════════════════════════════════════════

function buildHubStopCommand(home: string) {
	return {
		command: 'stop',
		describe: 'Stop the Epicenter hub',
		builder: (y: Argv) => y,
		handler: async () => {
			const pidFile = join(home, 'hub.pid');

			let pid: number;
			try {
				const raw = await readFile(pidFile, 'utf8');
				pid = Number.parseInt(raw.trim(), 10);
				if (Number.isNaN(pid)) {
					throw new Error('PID file contains invalid content');
				}
			} catch {
				console.error(
					`No PID file found at ${pidFile}.\n` +
						`The hub may not be running, or was not started with "epicenter hub start".`,
				);
				process.exitCode = 1;
				return;
			}

			try {
				process.kill(pid, 'SIGTERM');
				console.log(`Sent SIGTERM to hub (PID ${pid}).`);
			} catch (err) {
				const isNoSuchProcess =
					err instanceof Error &&
					'code' in err &&
					(err as NodeJS.ErrnoException).code === 'ESRCH';

				if (isNoSuchProcess) {
					console.log(
						`Process ${pid} is no longer running (stale PID file). Cleaning up.`,
					);
					await unlink(pidFile).catch(() => {});
				} else {
					console.error(
						`Failed to stop hub (PID ${pid}): ${err instanceof Error ? err.message : String(err)}`,
					);
					process.exitCode = 1;
				}
			}
		},
	};
}
