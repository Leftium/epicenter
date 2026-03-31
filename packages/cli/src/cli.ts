import yargs from 'yargs';
import { buildAuthCommand } from './commands/auth-command';
import { buildDataCommand } from './commands/data-command';
import { buildStartCommand } from './commands/start-command';
import { buildWorkspaceCommand } from './commands/workspace-command';
import { resolveEpicenterHome } from './util/paths';

/**
 * Create the Epicenter CLI instance.
 * @returns An object with a `run` method that parses and executes CLI commands.
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const home = resolveEpicenterHome();

			const cli = yargs()
				.scriptName('epicenter')
				.command(buildStartCommand())
				.command(buildWorkspaceCommand(home))
				.command(buildAuthCommand(home))
				.command(buildDataCommand())
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
