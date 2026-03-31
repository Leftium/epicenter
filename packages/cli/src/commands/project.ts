/**
 * Project management commands: init, install, uninstall.
 *
 * These commands manage the project scaffold and workspace source code.
 * `init` creates the project skeleton, `install` fetches from jsrepo registries,
 * `uninstall` removes installed workspaces.
 */

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { $ } from 'bun';
import type { AbsolutePath } from 'jsrepo';
import {
	DEFAULT_PROVIDERS,
	parseWantedItems,
	resolveAndFetchAllItems,
	resolveRegistries,
	resolveWantedItems,
} from 'jsrepo';
import type { Argv } from 'yargs';
import { output, outputError } from '../util/format-output';
import {
	addWorkspaceToConfig,
	removeWorkspaceFromConfig,
	toCamelCase,
	toFactoryName,
} from '../util/update-config';
import { defineCommand } from '../util/command';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract registry URL from a full item path like "github/org/repo/item". */
function extractRegistry(itemPath: string): string | undefined {
	const parts = itemPath.split('/');
	if (parts.length >= 4) {
		return parts.slice(0, 3).join('/');
	}
	return undefined;
}

/** Extract item name from a full item path. */
function extractItemName(itemPath: string): string {
	const parts = itemPath.split('/');
	if (parts.length >= 4) {
		return parts.slice(3).join('/');
	}
	return itemPath;
}


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

// ─── Install ─────────────────────────────────────────────────────────────────

/**
 * Core install logic extracted from the handler for linear control flow.
 * Throws on failure—the handler catches and formats the error.
 */
async function installWorkspace(dir: string, itemArg: string, registryFlag?: string) {
	// Verify config exists
	const configPath = join(dir, 'epicenter.config.ts');
	if (!(await Bun.file(configPath).exists())) {
		throw new Error('No epicenter.config.ts found. Run "epicenter init" first.');
	}

	// Parse registry + item
	const registryUrl = registryFlag ?? extractRegistry(itemArg);
	const itemName = registryFlag ? itemArg : extractItemName(itemArg);
	if (!registryUrl) {
		throw new Error('Could not determine registry. Use --registry or provide a full path like github/myorg/workspaces/my-app');
	}

	console.log(`Resolving ${itemName} from ${registryUrl}...`);
	const cwd = dir as AbsolutePath;

	// Resolve → parse → resolve → fetch (linear, throw on failure)
	const registriesResult = await resolveRegistries([registryUrl], { cwd, providers: DEFAULT_PROVIDERS });
	if (registriesResult.isErr()) throw new Error(`Failed to resolve registry: ${registriesResult.error}`);

	const parsedResult = parseWantedItems([itemName], { providers: DEFAULT_PROVIDERS, registries: [registryUrl] });
	if (parsedResult.isErr()) throw new Error(`Failed to parse item: ${parsedResult.error}`);

	const resolvedResult = await resolveWantedItems(parsedResult.value.wantedItems, {
		resolvedRegistries: registriesResult.value,
		nonInteractive: true,
	});
	if (resolvedResult.isErr()) throw new Error(`Failed to resolve item: ${resolvedResult.error}`);

	const fetchedItems = await resolveAndFetchAllItems(resolvedResult.value);
	if (fetchedItems.isErr()) throw new Error(`Failed to fetch item: ${fetchedItems.error}`);
	if (fetchedItems.value.length === 0) throw new Error('No items found');

	const item = fetchedItems.value[0]!;

	// Check if workspace already exists
	const wsDir = join(dir, 'workspaces', item.name);
	if (await Bun.file(join(wsDir, 'manifest.json')).exists()) {
		throw new Error(
			`Workspace "${item.name}" already exists at ./workspaces/${item.name}/. Remove it first with "epicenter uninstall ${item.name}".`,
		);
	}

	// Write files
	await mkdir(wsDir, { recursive: true });
	for (const file of item.files) {
		const filePath = join(wsDir, file.path);
		await mkdir(dirname(filePath), { recursive: true });
		await Bun.write(filePath, file.content);
	}
	console.log(`  ✓ Fetched ${item.name} (${item.files.length} files)`);
	console.log(`  ✓ Wrote to ./workspaces/${item.name}/`);

	// Write manifest.json with provenance
	const manifest = {
		registry: registryUrl,
		item: item.name,
		installedAt: new Date().toISOString(),
		files: item.files.map((f: { path: string }) => f.path),
	};
	await Bun.write(join(wsDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

	// Handle dependencies
	const deps: Record<string, string> = {};
	for (const dep of item.dependencies ?? []) {
		if (typeof dep === 'string') {
			deps[dep] = 'latest';
		} else {
			deps[dep.name] = dep.version ?? 'latest';
		}
	}
	if (Object.keys(deps).length > 0) {
		console.log('  Installing dependencies...');
		await $`bun install`.cwd(dir).quiet();
		console.log(`  ✓ Installed ${Object.keys(deps).length} dependencies`);
	}

	// Update epicenter.config.ts
	try {
		const configContent = await Bun.file(configPath).text();
		const factoryName = toFactoryName(item.name);
		const exportName = toCamelCase(item.name);
		const importPath = `./workspaces/${item.name}/workspace`;
		const updated = addWorkspaceToConfig(configContent, importPath, factoryName, exportName);
		await Bun.write(configPath, updated);
		console.log('  ✓ Updated epicenter.config.ts');
	} catch {
		console.log('  ⚠ Could not auto-update epicenter.config.ts. Add manually:');
		console.log(`    import { ${toFactoryName(item.name)} } from './workspaces/${item.name}/workspace';`);
		console.log(`    export const ${toCamelCase(item.name)} = ${toFactoryName(item.name)}();`);
	}

	output({
		installed: item.name,
		path: `./workspaces/${item.name}/`,
		files: item.files.length,
		dependencies: Object.keys(deps).length,
	});
}

/**
 * `epicenter install <item>` — install a workspace from a jsrepo registry.
 *
 * Fetches workspace source code via the jsrepo programmatic API, writes it to
 * `./workspaces/<name>/`, generates `manifest.json` with provenance, updates
 * `epicenter.config.ts`, and runs `bun install` for dependencies.
 *
 * @example
 * ```bash
 * epicenter install github/epicenterhq/workspaces/my-notes
 * epicenter install my-notes --registry github/epicenterhq/workspaces
 * ```
 */
export const installCommand = defineCommand({
		command: 'install <item>',
		describe: 'Install a workspace from a jsrepo registry',
		builder: (y: Argv) =>
			y
				.positional('item', {
					type: 'string',
					demandOption: true,
					describe:
						'Registry item to install (e.g. github/myorg/workspaces/my-app)',
				})
				.option('registry', {
					type: 'string',
					describe: 'Registry URL (e.g. github/myorg/workspaces)',
				})
				.option('dir', {
					type: 'string',
					default: '.',
					alias: 'C',
					description: 'Project directory containing epicenter.config.ts',
				}),
		handler: async (argv: any) => {
			try {
				await installWorkspace(resolve(argv.dir as string), argv.item as string, argv.registry as string | undefined);
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
