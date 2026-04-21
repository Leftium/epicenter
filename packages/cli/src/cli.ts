import yargs from 'yargs';
import { createAuthCommand } from './commands/auth';

/**
 * Create the Epicenter CLI instance.
 *
 * Post-redesign surface (see `specs/20260421T155436-cli-scripting-first-redesign.md`):
 *   - `auth` — manage Epicenter server sessions
 *   - `list` — tree view of runnable actions (TODO: Phase 4)
 *   - `run`  — invoke a `defineQuery` / `defineMutation` node by dot-path (TODO: Phase 3)
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const cli = yargs()
				.scriptName('epicenter')
				.command(createAuthCommand())
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
