/**
 * `epicenter export [workspace-id]` — export all workspace data as JSON.
 *
 * Loads the workspace from `epicenter.config.ts`, reads all table data,
 * and outputs it as a JSON object keyed by table name.
 */

import type { Argv, CommandModule } from 'yargs';
import { output, outputError } from '../util/format-output';
import { withWorkspace } from '../runtime/open-workspace';
import { withWorkspaceOptions } from '../util/with-workspace-options';

/**
 * Build the `export` command.
 *
 * Exports all data from the workspace as a JSON object where each key is
 * a table name and the value is an array of valid rows.
 *
 * @example
 * ```bash
 * epicenter export
 * epicenter export -w my-workspace
 * epicenter export --format json > backup.json
 * ```
 */
export function buildExportCommand(): CommandModule {
	return {
		command: 'export',
		describe: 'Export workspace data as JSON',
		builder: (y: Argv) =>
			withWorkspaceOptions(y).option('table', {
				type: 'string',
				describe: 'Export only a specific table',
			}),
		handler: async (argv: any) => {
			try {
				const result = await withWorkspace(
					{ dir: argv.dir, workspaceId: argv.workspace },
					(client) => {
						const data: Record<string, unknown[]> = {};
						const tableNames = argv.table
							? [argv.table as string]
							: Object.keys(client.definitions.tables);

						for (const tableName of tableNames) {
							const table = client.tables[tableName];
							if (!table) {
								throw new Error(
									`Table "${tableName}" not found in workspace "${client.id}"`,
								);
							}
							data[tableName] = table.getAllValid();
						}

						return data;
					},
				);
				output(result, { format: argv.format });
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	};
}
