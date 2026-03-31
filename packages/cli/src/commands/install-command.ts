/**
 * `epicenter install <item>` — install a workspace from a jsrepo registry.
 *
 * Fetches workspace source code via the jsrepo programmatic API, writes it to
 * `./workspaces/<name>/`, generates a `manifest.json` with provenance, updates
 * `epicenter.config.ts` with the import+export, and runs `bun install` for
 * any declared dependencies.
 */

import { mkdir } from 'node:fs/promises';
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
import type { Argv, CommandModule } from 'yargs';
import { output, outputError } from '../util/format-output';
import {
	addWorkspaceToConfig,
	toCamelCase,
	toFactoryName,
} from '../util/update-config';

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

/**
 * Build the `install` command.
 *
 * Installs a workspace from a jsrepo registry into the project's `./workspaces/`
 * directory and wires it into `epicenter.config.ts`.
 *
 * @example
 * ```bash
 * epicenter install github/epicenterhq/workspaces/my-notes
 * epicenter install my-notes --registry github/epicenterhq/workspaces
 * ```
 */
export function buildInstallCommand(): CommandModule {
	return {
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
			const dir = resolve(argv.dir as string);
			const itemArg = argv.item as string;

			// Verify config exists
			const configPath = join(dir, 'epicenter.config.ts');
			if (!(await Bun.file(configPath).exists())) {
				outputError(
					'No epicenter.config.ts found. Run "epicenter init" first.',
				);
				process.exitCode = 1;
				return;
			}

			// Parse registry + item
			const registryUrl = (argv.registry as string | undefined) ?? extractRegistry(itemArg);
			const itemName = argv.registry ? itemArg : extractItemName(itemArg);

			if (!registryUrl) {
				outputError(
					'Could not determine registry. Use --registry or provide a full path like github/myorg/workspaces/my-app',
				);
				process.exitCode = 1;
				return;
			}

			console.log(`Resolving ${itemName} from ${registryUrl}...`);

			const cwd = dir as AbsolutePath;

			// 1. Resolve registry
			const registriesResult = await resolveRegistries([registryUrl], {
				cwd,
				providers: DEFAULT_PROVIDERS,
			});
			if (registriesResult.isErr()) {
				outputError(
					`Failed to resolve registry: ${registriesResult.error}`,
				);
				process.exitCode = 1;
				return;
			}

			// 2. Parse wanted items
			const parsed = parseWantedItems([itemName], {
				providers: DEFAULT_PROVIDERS,
				registries: [registryUrl],
			});
			if (parsed.isErr()) {
				outputError(`Failed to parse item: ${parsed.error}`);
				process.exitCode = 1;
				return;
			}

			// 3. Resolve wanted items against registry manifest
			const resolved = await resolveWantedItems(
				parsed.value.wantedItems,
				{
					resolvedRegistries: registriesResult.value,
					nonInteractive: true,
				},
			);
			if (resolved.isErr()) {
				outputError(`Failed to resolve item: ${resolved.error}`);
				process.exitCode = 1;
				return;
			}

			// 4. Fetch file contents
			const items = await resolveAndFetchAllItems(resolved.value);
			if (items.isErr()) {
				outputError(`Failed to fetch item: ${items.error}`);
				process.exitCode = 1;
				return;
			}

			if (items.value.length === 0) {
				outputError('No items found');
				process.exitCode = 1;
				return;
			}

			const item = items.value[0]!;

			// Check if workspace already exists
			const wsDir = join(dir, 'workspaces', item.name);
			if (await Bun.file(join(wsDir, 'manifest.json')).exists()) {
				outputError(
					`Workspace "${item.name}" already exists at ./workspaces/${item.name}/. Remove it first with "epicenter uninstall ${item.name}".`,
				);
				process.exitCode = 1;
				return;
			}

			// 5. Write files to ./workspaces/<name>/
			await mkdir(wsDir, { recursive: true });
			for (const file of item.files) {
				const filePath = join(wsDir, file.path);
				await mkdir(dirname(filePath), { recursive: true });
				await Bun.write(filePath, file.content);
			}
			console.log(`  ✓ Fetched ${item.name} (${item.files.length} files)`);
			console.log(`  ✓ Wrote to ./workspaces/${item.name}/`);

			// 6. Write manifest.json with provenance
			const manifest = {
				registry: registryUrl,
				item: item.name,
				installedAt: new Date().toISOString(),
				files: item.files.map((f: { path: string }) => f.path),
			};
			await Bun.write(
				join(wsDir, 'manifest.json'),
				JSON.stringify(manifest, null, 2) + '\n',
			);

			// 7. Handle dependencies
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
				console.log(
					`  ✓ Installed ${Object.keys(deps).length} dependencies`,
				);
			}

			// 8. Update epicenter.config.ts
			try {
				const configContent = await Bun.file(configPath).text();
				const factoryName = toFactoryName(item.name);
				const exportName = toCamelCase(item.name);
				const importPath = `./workspaces/${item.name}/workspace`;

				const updated = addWorkspaceToConfig(
					configContent,
					importPath,
					factoryName,
					exportName,
				);
				await Bun.write(configPath, updated);
				console.log('  ✓ Updated epicenter.config.ts');
			} catch {
				console.log(
					`  ⚠ Could not auto-update epicenter.config.ts. Add manually:`,
				);
				console.log(
					`    import { ${toFactoryName(item.name)} } from './workspaces/${item.name}/workspace';`,
				);
				console.log(
					`    export const ${toCamelCase(item.name)} = ${toFactoryName(item.name)}();`,
				);
			}

			output({
				installed: item.name,
				path: `./workspaces/${item.name}/`,
				files: item.files.length,
				dependencies: Object.keys(deps).length,
			});
		},
	};
}
