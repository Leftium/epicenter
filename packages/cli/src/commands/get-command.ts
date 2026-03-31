/**
 * `epicenter get <table> <id>` — get a single row by ID from a table.
 *
 * Loads the workspace from `epicenter.config.ts`, finds the table,
 * retrieves the row, and outputs it as JSON.
 */

import type { Argv, CommandModule } from 'yargs';
import {
	resolveTable,
	runDataCommand,
	withWorkspaceOptions,
} from '../util/with-workspace-options';

/**
 * Build the `get` command.
 *
 * @example
 * ```bash
 * epicenter get posts abc123
 * epicenter get posts abc123 -C ./my-project
 * epicenter get posts abc123 -w my-workspace --format json
 * ```
 */
export function buildGetCommand(): CommandModule {
	return {
		command: 'get <table> <id>',
		describe: 'Get a row by ID from a table',
		builder: (y: Argv) =>
			withWorkspaceOptions(y)
				.positional('table', { type: 'string', demandOption: true })
				.positional('id', { type: 'string', demandOption: true }),
		handler: async (argv: any) => {
			await runDataCommand(
				{ dir: argv.dir, workspaceId: argv.workspace },
				(client) => {
					const result = resolveTable(client, argv.table).get(argv.id);
					if (result.status !== 'valid')
						throw new Error(`Row not found: ${argv.id}`);
					return result.row;
				},
				argv.format,
			);
		},
	};
}
