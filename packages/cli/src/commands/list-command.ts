/**
 * `epicenter list <table>` — list all valid rows in a table.
 *
 * Loads the workspace from `epicenter.config.ts`, finds the table,
 * and outputs all valid rows as JSON.
 */

import type { Argv, CommandModule } from 'yargs';
import {
	resolveTable,
	runDataCommand,
	withWorkspaceOptions,
} from '../util/with-workspace-options';

/**
 * Build the `list` command.
 *
 * @example
 * ```bash
 * epicenter list posts
 * epicenter list posts --format jsonl
 * epicenter list posts -C ./my-project -w my-workspace
 * ```
 */
export function buildListCommand(): CommandModule {
	return {
		command: 'list <table>',
		describe: 'List all valid rows in a table',
		builder: (y: Argv) =>
			withWorkspaceOptions(y).positional('table', {
				type: 'string',
				demandOption: true,
			}),
		handler: async (argv: any) => {
			await runDataCommand(
				{ dir: argv.dir, workspaceId: argv.workspace },
				(client) => resolveTable(client, argv.table).getAllValid(),
				argv.format,
			);
		},
	};
}
