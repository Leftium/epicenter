import { join } from 'node:path';
import * as Y from 'yjs';
import type { Argv } from 'yargs';
import { loadClientFromPath } from '../discovery';
import { formatYargsOptions, output, outputError } from '../format-output';
import { workspacesDir } from '../paths';

export function buildExportCommand(home: string) {
	return {
		command: 'export <workspace-id>',
		describe: 'Export workspace data as JSON',
		builder: (y: Argv) =>
			y
				.positional('workspace-id', {
					type: 'string' as const,
					demandOption: true,
					describe: 'Workspace ID to export',
				})
				.option('table', {
					type: 'string' as const,
					describe: 'Export only a specific table',
				})
				.options(formatYargsOptions()),
		handler: async (argv: {
			'workspace-id': string;
			table?: string;
			format?: 'json' | 'jsonl';
		}) => {
			const wsId = argv['workspace-id'];
			const wsPath = join(workspacesDir(home), wsId);
			const configPath = join(wsPath, 'epicenter.config.ts');

			if (!(await Bun.file(configPath).exists())) {
				outputError(`Workspace "${wsId}" not found at ${wsPath}`);
				process.exitCode = 1;
				return;
			}

			// Load the Y.Doc from disk if it exists
			const dataPath = join(wsPath, 'data', 'workspace.yjs');
			const client = await loadClientFromPath(configPath);

			if (await Bun.file(dataPath).exists()) {
				const data = await Bun.file(dataPath).arrayBuffer();
				Y.applyUpdate(client.ydoc, new Uint8Array(data));
			}

			const result: Record<string, unknown[]> = {};
			const tableNames = argv.table
				? [argv.table]
				: Object.keys(client.definitions.tables);

			for (const tableName of tableNames) {
				const table = client.tables[tableName];
				if (!table) {
					outputError(`Table "${tableName}" not found in workspace "${wsId}"`);
					process.exitCode = 1;
					return;
				}
				result[tableName] = table.getAllValid();
			}

			output(result, { format: argv.format });
		},
	};
}
