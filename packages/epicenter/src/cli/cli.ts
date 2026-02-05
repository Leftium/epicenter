import yargs from 'yargs';
import { createServer, DEFAULT_PORT } from '../server/server';
import type { Actions } from '../shared/actions';
import { buildActionCommands } from './command-builder';
import { buildKvCommands } from './commands/kv-commands';
import { buildMetaCommands } from './commands/meta-commands';
import { buildTableCommands } from './commands/table-commands';
import type { AnyWorkspaceClient } from './discovery';

type CLIOptions = {
	actions?: Actions;
};

export function createCLI(client: AnyWorkspaceClient, options?: CLIOptions) {
	let cli = yargs()
		.scriptName('epicenter')
		.usage('Usage: $0 <command> [options]')
		.help()
		.version()
		.strict()
		.command(
			'serve',
			'Start HTTP server with REST and WebSocket sync endpoints',
			(yargs) =>
				yargs.option('port', {
					type: 'number',
					description: 'Port to run the server on',
					default: DEFAULT_PORT,
				}),
			(argv) => {
				// Cast needed: CLI uses static WorkspaceClient type, server uses dynamic type
				// Both are structurally compatible at runtime
				createServer(client as any, {
					port: argv.port,
					actions: options?.actions,
				}).start();
			},
		);

	// Add meta commands (tables, workspaces)
	const metaCommands = buildMetaCommands(client);
	for (const cmd of metaCommands) {
		cli = cli.command(cmd);
	}

	// Add table commands for each table in each workspace
	const tableCommands = buildTableCommands(client);
	for (const cmd of tableCommands) {
		cli = cli.command(cmd);
	}

	// Add KV commands
	const kvCommands = buildKvCommands(client);
	for (const cmd of kvCommands) {
		cli = cli.command(cmd);
	}

	// Add action commands if provided
	if (options?.actions) {
		const commands = buildActionCommands(options.actions);
		for (const cmd of commands) {
			cli = cli.command(cmd);
		}
	}

	return {
		async run(argv: string[]) {
			const cleanup = async () => {
				await client.destroy();
				process.exit(0);
			};
			process.on('SIGINT', cleanup);
			process.on('SIGTERM', cleanup);

			try {
				await cli.parse(argv);
			} finally {
				process.off('SIGINT', cleanup);
				process.off('SIGTERM', cleanup);
				await client.destroy();
			}
		},
	};
}
