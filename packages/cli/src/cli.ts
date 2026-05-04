import yargs from 'yargs';
import { authCommand } from './commands/auth';
import { downCommand } from './commands/down';
import { listCommand } from './commands/list';
import { logsCommand } from './commands/logs';
import { peersCommand } from './commands/peers';
import { psCommand } from './commands/ps';
import { runCommand } from './commands/run';
import { upCommand } from './commands/up';

/**
 * Create the Epicenter CLI instance.
 *
 * Introspect and invoke `defineQuery` / `defineMutation` actions in
 * `epicenter.config.ts`, either locally or on a peer that's online right now.
 *
 *   - `auth`:  manage the local machine auth session (pre-workspace)
 *   - `list`:  tree view of runnable actions (local schema is authoritative)
 *   - `run`:   invoke one by dot-path; `--peer` dispatches over RPC
 *   - `peers`: enumerate other clients currently online via Yjs awareness
 *
 * Specs: `specs/20260421T155436-cli-scripting-first-redesign.md` (base
 * surface), `specs/20260423T174126-cli-remote-peer-rpc.md` (`peers` + `--peer`).
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const cli = yargs()
				.scriptName('epicenter')
				.command(authCommand)
				.command(downCommand)
				.command(listCommand)
				.command(logsCommand)
				.command(peersCommand)
				.command(psCommand)
				.command(runCommand)
				.command(upCommand)
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
