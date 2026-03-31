/**
 * `epicenter delete <table> <id>` — delete a row by ID from a table.
 *
 * Loads the workspace from `epicenter.config.ts`, finds the table,
 * deletes the row, and outputs a confirmation.
 */

import type { Argv, CommandModule } from 'yargs';
import {
	resolveTable,
	runDataCommand,
	withWorkspaceOptions,
} from '../util/with-workspace-options';

/**
 * Build the `delete` command.
 *
 * @example
 * ```bash
 * epicenter delete posts abc123
 * epicenter delete posts abc123 -C ./my-project -w my-workspace
 * ```
 */
export function buildDeleteCommand(): CommandModule {
	return {
		command: 'delete <table> <id>',
		describe: 'Delete a row by ID from a table',
		builder: (y: Argv) =>
			withWorkspaceOptions(y)
				.positional('table', { type: 'string', demandOption: true })
				.positional('id', { type: 'string', demandOption: true }),
		handler: async (argv: any) => {
			await runDataCommand(
				{ dir: argv.dir, workspaceId: argv.workspace },
				(client) => {
					resolveTable(client, argv.table).delete(argv.id);
					return { status: 'deleted', id: argv.id };
				},
				argv.format,
			);
		},
	};
}
