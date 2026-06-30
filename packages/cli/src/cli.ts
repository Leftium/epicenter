import yargs from 'yargs';
import { authCommand } from './commands/auth.js';
import { blobsCommand } from './commands/blobs.js';
import { callCommand, toolsCommand } from './commands/cross-device-tools.js';
import { daemonCommand } from './commands/daemon.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { matterCommand } from './commands/matter.js';
import { peersCommand } from './commands/peers.js';
import { runCommand } from './commands/run.js';

/**
 * Create the Epicenter CLI instance.
 *
 * Introspect and invoke `defineQuery` / `defineMutation` actions exposed by the
 * configured mount, run against this device's own daemon.
 *
 *   - `auth`:  manage the local machine auth session (pre-workspace)
 *   - `blobs`: archive a file/URL into the content-addressed cloud blob store
 *   - `init`:  scaffold epicenter.config.ts (explicit root creation)
 *   - `daemon`: operate daemon lifecycle commands
 *   - `list`:  runnable actions for the mounted runtime (local schema is authoritative)
 *   - `matter`: lint a folder of typed markdown (disk is the source; SQLite is a projection)
 *   - `run`:   invoke one by action key against the local daemon
 *   - `peers`: enumerate other clients currently online via the workspace presence row
 *   - `tools`/`call`: list or call a peer device's MCP tools over the relay floor
 *
 * Every mount action is invoked through `run`, e.g.
 * `epicenter run markdown_rebuild '{}'` to re-materialize the read-only
 * markdown projection; results come back as JSON on stdout. Materialized `.md`
 * is read-only: mutate app data through actions, never by editing the files.
 * Reaching another device's capability is `tools`/`call` over the relay floor
 * (the explicitly-exposed MCP routes, ADR-0078), never a flag on `run`.
 *
 * Specs: `specs/20260421T155436-cli-scripting-first-redesign.md` (base surface).
 */
export function createCLI() {
	return {
		run: async (argv: string[]) => {
			const cli = yargs()
				.scriptName('epicenter')
				.command(authCommand)
				.command(blobsCommand)
				.command(initCommand)
				.command(daemonCommand)
				.command(listCommand)
				.command(matterCommand)
				.command(peersCommand)
				.command(runCommand)
				.command(toolsCommand)
				.command(callCommand)
				.demandCommand(1)
				.strict()
				.exitProcess(false)
				.help();

			await cli.parse(argv);
		},
	};
}
