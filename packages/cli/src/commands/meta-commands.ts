import type { CommandModule } from 'yargs';
import { formatYargsOptions, output } from '../format-output.js';

/**
 * Build the 'tables' meta command for a workspace.
 *
 * Table names are fetched from the server's discovery response
 * at CLI startup and passed in directly.
 */
export function buildTablesCommand(tableNames: string[]): CommandModule {
	return {
		command: 'tables',
		describe: 'List all table names',
		builder: (yargs) => yargs.options(formatYargsOptions()),
		handler: (argv) => {
			output(tableNames, { format: argv.format as any });
		},
	};
}
