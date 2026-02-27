import { join } from 'node:path';
import type { Argv } from 'yargs';
import { loadClientFromPath } from '../discovery';
import { outputError } from '../format-output';
import { workspacesDir } from '../paths';

export function buildRunCommand(home: string) {
	return {
		command: 'run <workspace-id>',
		describe: 'Run a single workspace as a standalone server',
		builder: (y: Argv) =>
			y
				.positional('workspace-id', {
					type: 'string' as const,
					demandOption: true,
					describe: 'Workspace ID to run',
				})
				.option('port', {
					type: 'number' as const,
					default: 4000,
					describe: 'Port to run on',
				})
				.option('hub', {
					type: 'string' as const,
					describe: 'Hub URL for Yjs sync (e.g. wss://hub.example.com)',
				}),
		handler: async (argv: {
			'workspace-id': string;
			port: number;
			hub?: string;
		}) => {
			const wsId = argv['workspace-id'];
			const wsPath = join(workspacesDir(home), wsId);
			const configPath = join(wsPath, 'epicenter.config.ts');

			if (!(await Bun.file(configPath).exists())) {
				outputError(`Workspace "${wsId}" not found at ${wsPath}`);
				process.exitCode = 1;
				return;
			}

			const client = await loadClientFromPath(configPath);

			const { createLocalServer } = await import('@epicenter/server-local');
			const server = createLocalServer({
				clients: [client],
				port: argv.port,
				...(argv.hub ? { hubUrl: argv.hub } : {}),
			});
			server.start();

			console.log(`Running ${wsId} on http://localhost:${argv.port}`);
			if (argv.hub) {
				console.log(`Syncing to hub: ${argv.hub}`);
			}
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
