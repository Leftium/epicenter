/**
 * Project management commands: init, uninstall.
 *
 * These commands manage the project scaffold and workspace source code.
 * `init` creates the project skeleton, `uninstall` removes installed workspaces.
 */

import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Argv } from 'yargs';
import { output, outputError } from '../util/format-output';
import {
	removeWorkspaceFromConfig,
	toCamelCase,
} from '../util/update-config';
import { defineCommand } from '../util/command';

// ─── Init ────────────────────────────────────────────────────────────────────

const CONFIG_TEMPLATE = `// Epicenter workspace configuration.
// Import workspace factories from ./workspaces/ and export them as named exports.
// Each export is auto-discovered by the CLI and daemon.
//
// Example:
//   import { createMyWorkspace } from './workspaces/my-workspace/workspace';
//   export const myWorkspace = createMyWorkspace()
//     .withExtension('persistence', setupPersistence);

`;

const GITIGNORE_TEMPLATE = `# Epicenter runtime data (persistence, SQLite, logs)
.epicenter/
`;

/**
 * `epicenter init` — scaffold a new Epicenter project.
 *
 * Creates `epicenter.config.ts` (with commented example), `package.json`
 * (with `@epicenter/workspace` dependency), and `.gitignore` (includes `.epicenter/`).
 * Safe to run in an existing directory—skips files that already exist.
 *
 * @example
 * ```bash
 * mkdir my-project && cd my-project
 * epicenter init
 * ```
 */
export const initCommand = defineCommand({
		command: 'init',
		describe: 'Initialize a new Epicenter project',
		builder: (y) =>
			y.option('dir', {
				type: 'string',
				default: '.',
				alias: 'C',
				description: 'Directory to initialize (default: current directory)',
			}),
		handler: async (argv: any) => {
			const dir = argv.dir as string;
			const created: string[] = [];
			const skipped: string[] = [];

			try {
				// epicenter.config.ts
				const configPath = join(dir, 'epicenter.config.ts');
				if (await Bun.file(configPath).exists()) {
					skipped.push('epicenter.config.ts');
				} else {
					await Bun.write(configPath, CONFIG_TEMPLATE);
					created.push('epicenter.config.ts');
				}

				// package.json
				const pkgPath = join(dir, 'package.json');
				if (await Bun.file(pkgPath).exists()) {
					skipped.push('package.json');
				} else {
					const pkg = {
						name: 'epicenter-project',
						private: true,
						dependencies: {
							'@epicenter/workspace': 'latest',
						},
					};
					await Bun.write(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
					created.push('package.json');
				}

				// .gitignore — append if exists, create if not
				const gitignorePath = join(dir, '.gitignore');
				if (await Bun.file(gitignorePath).exists()) {
					const existing = await Bun.file(gitignorePath).text();
					if (existing.includes('.epicenter/')) {
						skipped.push('.gitignore');
					} else {
						await Bun.write(
							gitignorePath,
							existing.trimEnd() + '\n\n' + GITIGNORE_TEMPLATE,
						);
						created.push('.gitignore (appended)');
					}
				} else {
					await Bun.write(gitignorePath, GITIGNORE_TEMPLATE);
					created.push('.gitignore');
				}

				output({ created, skipped });
			} catch (err) {
				outputError(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	});


// ─── Uninstall ───────────────────────────────────────────────────────────────

/**
 * `epicenter uninstall <workspace-id>` — remove a workspace from the project.
 *
 * Deletes `./workspaces/<id>/` and removes the matching import+export
 * from `epicenter.config.ts`.
 *
 * @example
 * ```bash
 * epicenter uninstall my-notes
 * epicenter uninstall my-notes -C ./my-project
 * ```
 */
export const uninstallCommand = defineCommand({
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
				try {
					const dirExists =
						(await Bun.file(join(wsPath, 'workspace.ts')).exists()) ||
						(await Bun.file(join(wsPath, 'definition.ts')).exists());
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
	});
