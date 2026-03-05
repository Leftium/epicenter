import yargs from 'yargs';
import { buildAuthCommand } from './commands/auth-command';
import { buildDataCommand } from './commands/data-command';
import { buildHubCommand } from './commands/hub-command';
import { buildSidecarCommand } from './commands/sidecar-command';
import { buildWorkspaceCommand } from './commands/workspace-command';
import { resolveEpicenterHome } from './paths';

/**
 * Create the Epicenter CLI instance.
 * @returns An object with a `run` method that parses and executes CLI commands.
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const home = resolveEpicenterHome();
			const serverUrl = `http://localhost:3913`;

			const cli = yargs()
				.scriptName('epicenter')
				.command(buildWorkspaceCommand(home))
				.command(buildSidecarCommand(home))
				.command(buildHubCommand(home))
				.command(buildAuthCommand(home))
				.command(buildDataCommand(serverUrl))
				.demandCommand(1)
				.strict()
				.help();

			await cli.parse(argv);
		},
	};
}
