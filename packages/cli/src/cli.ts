import yargs from 'yargs';
import { createAuthCommand } from './commands/auth';
import { createListCommand } from './commands/list';
import { createRunCommand } from './commands/run';

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
				.command(createListCommand())
				.command(createRunCommand())
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
