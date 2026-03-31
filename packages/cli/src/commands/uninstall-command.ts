/**
 * `epicenter uninstall <workspace-id>` — remove a workspace from the project.
 *
 * Deletes `./workspaces/<id>/` and removes the matching import+export
 * from `epicenter.config.ts`.
 */

import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Argv, CommandModule } from 'yargs';
import { output, outputError } from '../util/format-output';
import {
	removeWorkspaceFromConfig,
	toCamelCase,
} from '../util/update-config';

/**
 * Build the `uninstall` command.
 *
 * Removes a workspace's source files and its entry in `epicenter.config.ts`.
 *
 * @example
 * ```bash
 * epicenter uninstall my-notes
 * epicenter uninstall my-notes -C ./my-project
 * ```
 */
export function buildUninstallCommand(): CommandModule {
	return {
		command: 'uninstall <workspace-id>',
		describe: 'Remove a workspace from the project',
		builder: (y: Argv) =>
			y
				.positional('workspace-id', {
					type: 'string',
					demandOption: true,
					describe: 'Workspace ID to remove',
				})
				.option('dir', {
					type: 'string',
					default: '.',
					alias: 'C',
					description: 'Project directory containing epicenter.config.ts',
				}),
		handler: async (argv: any) => {
			const dir = resolve(argv.dir as string);
			const wsId = argv['workspace-id'] as string;
			const wsPath = join(dir, 'workspaces', wsId);

			// Check if workspace exists
			if (!(await Bun.file(join(wsPath, 'manifest.json')).exists())) {
				// Also check if directory exists at all
				try {
					const dirExists = await Bun.file(join(wsPath, 'workspace.ts')).exists() ||
						await Bun.file(join(wsPath, 'definition.ts')).exists();
					if (!dirExists) {
						outputError(
							`Workspace "${wsId}" not found at ./workspaces/${wsId}/`,
						);
						process.exitCode = 1;
						return;
					}
				} catch {
					outputError(
						`Workspace "${wsId}" not found at ./workspaces/${wsId}/`,
					);
					process.exitCode = 1;
					return;
				}
			}

			// Remove workspace directory
			await rm(wsPath, { recursive: true, force: true });
			console.log(`  ✓ Removed ./workspaces/${wsId}/`);

			// Update epicenter.config.ts
			const configPath = join(dir, 'epicenter.config.ts');
			if (await Bun.file(configPath).exists()) {
				try {
					const content = await Bun.file(configPath).text();
					const importPath = `./workspaces/${wsId}/workspace`;
					const exportName = toCamelCase(wsId);

					const updated = removeWorkspaceFromConfig(
						content,
						importPath,
						exportName,
					);
					await Bun.write(configPath, updated);
					console.log('  ✓ Updated epicenter.config.ts');
				} catch {
					console.log(
						`  ⚠ Could not auto-update epicenter.config.ts. Remove the import/export manually.`,
					);
				}
			}

			output({ removed: wsId });
		},
	};
}
