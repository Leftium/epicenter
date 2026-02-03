import yargs from 'yargs';
import type { WorkspaceClient } from '../dynamic/workspace/types';
import { createServer, DEFAULT_PORT } from '../server/server';
import type { Actions } from '../shared/actions';
import { buildActionCommands } from './command-builder';

// biome-ignore lint/suspicious/noExplicitAny: WorkspaceClient is generic over tables/kv/extensions
type AnyWorkspaceClient = WorkspaceClient<any, any, any>;

type CLIOptions = {
	actions?: Actions;
};

export function createCLI(
	clients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: CLIOptions,
) {
	const clientArray = Array.isArray(clients) ? clients : [clients];

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
