/**
 * `epicenter tables` — list all table names in the workspace.
 *
 * Loads the workspace from `epicenter.config.ts` and outputs
 * the table names defined in the workspace schema.
 */

import type { Argv, CommandModule } from 'yargs';
import {
	runDataCommand,
	withWorkspaceOptions,
} from '../util/with-workspace-options';

/**
 * Build the `tables` command.
 *
 * @example
 * ```bash
 * epicenter tables
 * epicenter tables -C ./my-project
 * epicenter tables -w my-workspace --format json
 * ```
 */
export function buildTablesCommand(): CommandModule {
	return {
		command: 'tables',
		describe: 'List all table names in the workspace',
		builder: (y: Argv) => withWorkspaceOptions(y),
		handler: async (argv: any) => {
			await runDataCommand(
				{ dir: argv.dir, workspaceId: argv.workspace },
				(client) => Object.keys(client.definitions.tables),
				argv.format,
			);
		},
	};
}
