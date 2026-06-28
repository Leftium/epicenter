import yargs from 'yargs';
import { authCommand } from './commands/auth.js';
import { blobsCommand } from './commands/blobs.js';
import { daemonCommand } from './commands/daemon.js';
import { devicesCommand } from './commands/devices.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { matterCommand } from './commands/matter.js';
import { peersCommand } from './commands/peers.js';
import { runCommand } from './commands/run.js';

/**
 * Create the Epicenter CLI instance.
 *
 * Introspect and invoke `defineQuery` / `defineMutation` actions exposed by
 * configured mount, either locally or on a peer that's online right now.
 *
 *   - `auth`:  manage the local machine auth session (pre-workspace)
 *   - `blobs`: archive a file/URL into the content-addressed cloud blob store
 *   - `init`:  scaffold epicenter.config.ts (explicit root creation)
 *   - `daemon`: operate daemon lifecycle commands
 *   - `list`:  runnable actions for the mounted runtime (local schema is authoritative)
 *   - `matter`: lint a folder of typed markdown (disk is the source; SQLite is a projection)
 *   - `run`:   invoke one by action key; `--peer` dispatches over RPC
 *   - `peers`: enumerate other clients currently online via the workspace presence row
 *   - `devices`: list this account's devices from the per-person account-doc roster
 *
 * Every mount action is invoked through `run`, e.g.
 * `epicenter run markdown_rebuild '{}'` to re-materialize the read-only
 * markdown projection; results come back as JSON on stdout. Materialized `.md`
 * is read-only: mutate app data through actions, never by editing the files.
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
				.command(blobsCommand)
				.command(initCommand)
				.command(daemonCommand)
				.command(devicesCommand)
				.command(listCommand)
				.command(matterCommand)
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
