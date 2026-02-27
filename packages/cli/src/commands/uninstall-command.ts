import { lstat, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Argv } from 'yargs';
import { output, outputError } from '../format-output';
import { workspacesDir } from '../paths';

export function buildUninstallCommand(home: string) {
	return {
		command: 'uninstall <workspace-id>',
		describe: 'Remove a workspace (delete directory or unlink symlink)',
		builder: (y: Argv) =>
			y.positional('workspace-id', {
				type: 'string' as const,
				demandOption: true,
				describe: 'Workspace ID to remove',
			}),
		handler: async (argv: { 'workspace-id': string }) => {
			const wsId = argv['workspace-id'];
			const wsPath = join(workspacesDir(home), wsId);

			let stat;
			try {
				stat = await lstat(wsPath);
			} catch {
				outputError(`Workspace "${wsId}" not found at ${wsPath}`);
				process.exitCode = 1;
				return;
			}

			if (stat.isSymbolicLink()) {
				await unlink(wsPath);
				output({ removed: wsId, type: 'unlinked' });
			} else {
				await rm(wsPath, { recursive: true, force: true });
				output({ removed: wsId, type: 'deleted' });
			}
		},
	};
}
