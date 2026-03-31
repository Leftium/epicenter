/**
 * `epicenter count <table>` — count valid rows in a table.
 *
 * Loads the workspace from `epicenter.config.ts`, finds the table,
 * and outputs the count of valid rows.
 */

import type { Argv, CommandModule } from 'yargs';
import {
	resolveTable,
	runDataCommand,
	withWorkspaceOptions,
} from '../util/with-workspace-options';

/**
 * Build the `count` command.
 *
 * @example
 * ```bash
 * epicenter count posts
 * epicenter count posts -C ./my-project
 * ```
 */
export function buildCountCommand(): CommandModule {
	return {
		command: 'count <table>',
		describe: 'Count valid rows in a table',
		builder: (y: Argv) =>
			withWorkspaceOptions(y).positional('table', {
				type: 'string',
				demandOption: true,
			}),
		handler: async (argv: any) => {
			await runDataCommand(
				{ dir: argv.dir, workspaceId: argv.workspace },
				(client) => ({
					count: resolveTable(client, argv.table).getAllValid().length,
				}),
				argv.format,
			);
		},
	};
}
