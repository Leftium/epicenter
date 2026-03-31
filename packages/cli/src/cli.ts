import { homedir } from 'node:os';
import { join } from 'node:path';
import yargs from 'yargs';
import { buildAuthCommand } from './commands/auth';
import {
	buildCountCommand,
	buildDeleteCommand,
	buildExportCommand,
	buildGetCommand,
	buildListCommand,
	buildTablesCommand,
} from './commands/data';
import { buildDescribeCommand } from './commands/describe';
import { buildKvCommand } from './commands/kv';
import {
	buildInitCommand,
	buildInstallCommand,
	buildUninstallCommand,
} from './commands/project';
import { buildRunCommand } from './commands/run';
import { buildStartCommand } from './commands/start';

/** Resolution order: EPICENTER_HOME env > ~/.epicenter/ */
export function resolveEpicenterHome(flagValue?: string): string {
	return flagValue ?? Bun.env.EPICENTER_HOME ?? join(homedir(), '.epicenter');
}

/**
 * Create the Epicenter CLI instance.
 *
 * Registers all top-level commands: table CRUD (get, list, count, delete),
 * tables, kv, export, init, install, uninstall, run, describe, start, and auth.
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
				.command(buildInitCommand())
				.command(buildInstallCommand())
				.command(buildUninstallCommand())
				.command(buildRunCommand())
				.command(buildDescribeCommand())
				.command(buildAuthCommand(home))
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
