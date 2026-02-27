import { lstat, mkdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Argv } from 'yargs';
import { loadClientFromPath } from '../discovery';
import { output, outputError } from '../format-output';
import { workspacesDir } from '../paths';

export function buildAddCommand(home: string) {
	return {
		command: 'add <path>',
		describe: 'Symlink a local workspace into Epicenter',
		builder: (y: Argv) =>
			y.positional('path', {
				type: 'string' as const,
				demandOption: true,
				describe: 'Path to a directory containing epicenter.config.ts',
			}),
		handler: async (argv: { path: string }) => {
			const targetPath = resolve(argv.path);
			const configPath = join(targetPath, 'epicenter.config.ts');

			if (!(await Bun.file(configPath).exists())) {
				outputError(`No epicenter.config.ts found at ${targetPath}`);
				process.exitCode = 1;
				return;
			}

			const client = await loadClientFromPath(configPath);
			const workspaceId = client.id;
			const linkPath = join(workspacesDir(home), workspaceId);

			try {
				await lstat(linkPath);
				outputError(`Workspace "${workspaceId}" already exists at ${linkPath}`);
				process.exitCode = 1;
				return;
			} catch {
				// doesn't exist — good
			}

			await mkdir(workspacesDir(home), { recursive: true });
			await symlink(targetPath, linkPath);
			output({ added: workspaceId, path: targetPath, link: linkPath });
		},
	};
}
