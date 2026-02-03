import yargs from 'yargs';
import { createServer, DEFAULT_PORT } from '../server/server';
import type { Actions } from '../shared/actions';
import type { WorkspaceClient } from '../static/types';
import { buildActionCommands } from './command-builder';
import { buildKvCommands } from './commands/kv-commands';
import {
	buildMetaCommands,
	isReservedCommand,
	RESERVED_COMMANDS,
} from './commands/meta-commands';
import { buildTableCommands } from './commands/table-commands';
import { createCommandConfig, type CommandConfig } from './discovery';

// biome-ignore lint/suspicious/noExplicitAny: WorkspaceClient is generic over tables/kv/capabilities
type AnyWorkspaceClient = WorkspaceClient<any, any, any, any>;

type CLIOptions = {
	actions?: Actions;
};

export function createCLI(
	clients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: CLIOptions,
) {
	const clientArray = Array.isArray(clients) ? clients : [clients];
	const config = createCommandConfig(clientArray);

	// Validate workspace and table names don't conflict with reserved commands
	validateNames(config);

	let cli = yargs()
		.scriptName('epicenter')
		.usage('Usage: $0 <command> [options]')
		.help()
		.version()
		.strict()
		.option('port', {
			type: 'number',
			description: 'Port to run the server on',
			default: DEFAULT_PORT,
		})
		.command(
			'serve',
			'Start HTTP server with REST and WebSocket sync endpoints',
			() => {},
			(argv) => {
				createServer(clientArray, {
					port: argv.port,
					actions: options?.actions,
				}).start();
			},
		);

	// Add meta commands (tables, workspaces)
	const metaCommands = buildMetaCommands(config);
	for (const cmd of metaCommands) {
		cli = cli.command(cmd);
	}

	// Add table commands for each table in each workspace
	const tableCommands = buildTableCommands(config);
	for (const cmd of tableCommands) {
		cli = cli.command(cmd);
	}

	// Add KV commands
	const kvCommands = buildKvCommands(config);
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
				for (const client of clientArray) {
					await client.destroy();
				}
				process.exit(0);
			};
			process.on('SIGINT', cleanup);
			process.on('SIGTERM', cleanup);

			try {
				await cli.parse(argv);
			} finally {
				process.off('SIGINT', cleanup);
				process.off('SIGTERM', cleanup);
				for (const client of clientArray) {
					await client.destroy();
				}
			}
		},
	};
}

/**
 * Validate that workspace and table names don't conflict with reserved commands.
 * Logs warnings for conflicts but doesn't fail.
 */
function validateNames(config: CommandConfig): void {
	const isSingleClient = config.mode === 'single';

	for (const client of config.clients) {
		// With multiple clients, check workspace names (they become commands)
		if (!isSingleClient && isReservedCommand(client.id)) {
			console.warn(
				`Warning: Workspace "${client.id}" conflicts with reserved command. ` +
					`Reserved commands: ${RESERVED_COMMANDS.join(', ')}`,
			);
		}

		// With single client, check table names (they become top-level commands)
		if (isSingleClient) {
			for (const tableName of Object.keys(client.tables)) {
				if (isReservedCommand(tableName)) {
					console.warn(
						`Warning: Table "${tableName}" conflicts with reserved command. ` +
							`Reserved commands: ${RESERVED_COMMANDS.join(', ')}`,
					);
				}
			}
		}
	}
}
