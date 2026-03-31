import yargs from 'yargs';
import { buildAuthCommand } from './commands/auth-command';
import { buildCountCommand } from './commands/count-command';
import { buildDeleteCommand } from './commands/delete-command';
import { buildExportCommand } from './commands/export-command';
import { buildGetCommand } from './commands/get-command';
import { buildKvCommand } from './commands/kv-command';
import { buildListCommand } from './commands/list-command';
import { buildStartCommand } from './commands/start-command';
import { buildTablesCommand } from './commands/tables-command';
import { resolveEpicenterHome } from './util/paths';

/**
 * Create the Epicenter CLI instance.
 *
 * Registers all top-level commands: table CRUD (get, list, count, delete),
 * tables, kv, export, start, and auth.
 *
 * @returns An object with a `run` method that parses and executes CLI commands.
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const home = resolveEpicenterHome();

			const cli = yargs()
				.scriptName('epicenter')
				.command(buildStartCommand())
				.command(buildGetCommand())
				.command(buildListCommand())
				.command(buildCountCommand())
				.command(buildDeleteCommand())
				.command(buildTablesCommand())
				.command(buildKvCommand())
				.command(buildExportCommand())
				.command(buildAuthCommand(home))
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
