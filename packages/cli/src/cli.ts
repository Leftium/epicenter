import { createLocalServer } from '@epicenter/server';
import type { Argv } from 'yargs';
import yargs from 'yargs';
import { createApiClient } from './api-client';
import { buildActionCommand } from './command-builder';
import { buildKvCommand } from './commands/kv-commands';
import { buildTablesCommand } from './commands/meta-commands';
import { buildTableCommand } from './commands/table-commands';
import { buildWorkspacesCommand } from './commands/workspaces-command';
import { buildAddCommand } from './commands/add-command';
import { buildInstallCommand } from './commands/install-command';
import { buildLsCommand } from './commands/ls-command';
import { discoverAllWorkspaces, discoverWorkspaces } from './discovery';
import { resolveEpicenterHome } from './paths';

const DEFAULT_URL = 'http://localhost:3913';

type WorkspaceMetadata = {
	id: string;
	tables: string[];
	kv: string[];
	actions: string[];
};

async function fetchWorkspaceMetadata(
	baseUrl: string,
	workspaceId: string,
): Promise<WorkspaceMetadata> {
	const response = await fetch(`${baseUrl}/workspaces/${workspaceId}`);
	if (!response.ok) {
		if (response.status === 404) {
			throw new Error(`Workspace "${workspaceId}" not found on server.`);
		}
		throw new Error(`Server responded with ${response.status}`);
	}
	return response.json() as Promise<WorkspaceMetadata>;
}

/**
 * Build the serve command (in-process server, no HTTP client needed).
 */
function buildServeCommand() {
	return {
		command: 'serve',
		describe: 'Start HTTP server with REST and WebSocket sync endpoints',
		builder: (y: Argv) =>
			y
				.option('port', {
					type: 'number' as const,
					description: 'Port to run the server on',
					default: 3913,
				})
				.option('home', {
					type: 'string' as const,
					description: 'Override EPICENTER_HOME directory',
				})
				.option('dir', {
					type: 'string' as const,
					description: 'Directory to scan for workspace configs (deprecated: use epicenter add <path> instead)',
					array: true,
					deprecated: true,
				})
				.option('watch', {
					alias: 'w',
					type: 'boolean' as const,
					default: false,
					description:
						'Restart server when workspace config files change (uses bun --watch)',
				}),
		handler: async (argv: { port: number; home?: string; dir?: string[]; watch: boolean }) => {
			if (argv.watch) {
				// Re-exec with bun --watch, stripping --watch/-w to avoid recursion
				const args = process.argv.filter((a) => a !== '--watch' && a !== '-w');
				const proc = Bun.spawn(['bun', '--watch', ...args], {
					stdio: ['inherit', 'inherit', 'inherit'],
				});
				process.exitCode = await proc.exited;
				return;
			}

			let clients: Awaited<ReturnType<typeof discoverWorkspaces>>['clients'];
			let sources: Awaited<ReturnType<typeof discoverWorkspaces>>['sources'];

			if (argv.dir) {
				console.warn('Warning: --dir is deprecated. Use "epicenter add <path>" to register workspaces.\n');
				({ clients, sources } = await discoverAllWorkspaces(argv.dir));
			} else {
				const home = resolveEpicenterHome(argv.home);
				({ clients, sources } = await discoverWorkspaces(home));
			}

			if (clients.length === 0) {
				console.log('No workspaces found. Starting server with no workspaces.');
			} else {
				console.log(`\nLoaded ${clients.length} workspace(s):`);
				for (const [id, path] of sources) {
					console.log(`  - ${id} (${path})`);
				}
			}

			const server = createLocalServer({
				clients,
				port: argv.port,
			});
			server.start();

			console.log(`\nEpicenter server on http://localhost:${argv.port}`);
			console.log(`API docs: http://localhost:${argv.port}/openapi\n`);

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

/**
 * Create the CLI with two modes:
 * - `serve`: loads workspaces in-process, starts server
 * - Everything else: talks to a running server via HTTP
 */
export function createCLI() {
	return {
		async run(argv: string[]) {
			const home = resolveEpicenterHome();

			// Tier 1: commands that don't need a running server
			const tier1Commands = ['serve', 'add', 'ls', 'install'];
			if (tier1Commands.includes(argv[0] ?? '')) {
				const cli = yargs()
					.scriptName('epicenter')
					.command(buildServeCommand() as any)
					.command(buildAddCommand(home) as any)
					.command(buildInstallCommand(home) as any)
					.command(buildLsCommand(home) as any)
					.help()
					.version()
					.strict();

				await cli.parse(argv);
				return;
			}

			// For all other commands, need a running server
			const serverUrl = DEFAULT_URL;
			const api = createApiClient(serverUrl);

			// The `workspaces` command doesn't need workspace context
			if (argv[0] === 'workspaces') {
				const cli = yargs()
					.scriptName('epicenter')
					.command(buildWorkspacesCommand(api))
					.help()
					.version()
					.strict();

				await cli.parse(argv);
				return;
			}

			// All other commands require a workspace ID as first positional
			const workspaceId = argv[0];
			if (!workspaceId) {
				console.error(
					'Usage: epicenter <workspace> <command>\n' +
						'       epicenter serve [--port 3913]\n' +
						'       epicenter workspaces\n\n' +
						'Run "epicenter workspaces" to list available workspaces.',
				);
				process.exitCode = 1;
				return;
			}

			// Fetch workspace metadata from server
			let metadata: WorkspaceMetadata;
			try {
				metadata = await fetchWorkspaceMetadata(serverUrl, workspaceId);
			} catch (error) {
				if (error instanceof TypeError && error.message.includes('fetch')) {
					console.error(
						`No Epicenter server running on ${serverUrl}.\nStart one with: epicenter serve`,
					);
				} else {
					console.error(error instanceof Error ? error.message : String(error));
				}
				process.exitCode = 1;
				return;
			}

			// Build workspace-scoped CLI
			let cli = yargs().scriptName(`epicenter ${workspaceId}`).help().version();

			// Register table commands (dynamically from server metadata)
			for (const tableName of metadata.tables) {
				cli = cli.command(buildTableCommand(api, workspaceId, tableName));
			}

			// Register static commands
			cli = cli
				.command(buildTablesCommand(metadata.tables))
				.command(buildKvCommand(api, workspaceId))
				.command(buildActionCommand(serverUrl, workspaceId));

			// Parse remaining args (skip workspace ID)
			await cli.parse(argv.slice(1));
		},
	};
}
