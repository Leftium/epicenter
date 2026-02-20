import yargs from 'yargs';
import { buildActionCommands } from './command-builder';
import { buildKvCommands } from './commands/kv-commands';
import { buildMetaCommands } from './commands/meta-commands';
import { buildTableCommands } from './commands/table-commands';
import type { AnyWorkspaceClient } from './discovery';

export function createCLI(client: AnyWorkspaceClient) {
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
					default: 3913,
				}),
			async (argv) => {
				try {
					const { createServer } = await import('@epicenter/server');
					const server = createServer(client, {
						port: argv.port,
					});
					server.start();

					console.log(`\nEpicenter server on http://localhost:${argv.port}`);
					console.log(`API docs: http://localhost:${argv.port}/openapi\n`);

					// Override the CLI's generic cleanup with server-aware shutdown.
					// server.stop() gracefully closes the HTTP server AND destroys clients.
					const shutdown = async () => {
						await server.stop();
						process.exit(0);
					};
					process.on('SIGINT', shutdown);
					process.on('SIGTERM', shutdown);

					// Block forever — signal handlers above manage shutdown
					await new Promise(() => {});
				} catch {
					console.error(
						'Error: @epicenter/server is not installed.\n\n' +
							'Install it to use the serve command:\n' +
							'  bun add @epicenter/server\n',
					);
					process.exit(1);
				}
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

	// Add action commands from client.actions
	if (client.actions) {
		const commands = buildActionCommands(client.actions);
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
