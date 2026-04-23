import yargs from 'yargs';
import { createAuthCommand } from './commands/auth';
import { listCommand } from './commands/list';
import { peersCommand } from './commands/peers';
import { runCommand } from './commands/run';

/**
 * Create the Epicenter CLI instance.
 *
 * Post-redesign surface (see `specs/20260421T155436-cli-scripting-first-redesign.md`):
 *   - `auth` — manage Epicenter server sessions
 *   - `list` — tree view of runnable actions
 *   - `run`  — invoke a `defineQuery` / `defineMutation` node by dot-path
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const cli = yargs()
				.scriptName('epicenter')
				.command(createAuthCommand())
				.command(listCommand)
				.command(peersCommand)
				.command(runCommand)
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
