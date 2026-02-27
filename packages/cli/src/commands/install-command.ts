import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import { output, outputError } from '../format-output';
import { workspacesDir } from '../paths';

export function buildInstallCommand(home: string) {
	return {
		command: 'install <item>',
		describe: 'Install a workspace from a jsrepo registry',
		builder: (y: Argv) =>
			y
				.positional('item', {
					type: 'string' as const,
					demandOption: true,
					describe: 'Registry item to install (e.g. github/myorg/workspaces/my-app)',
				})
				.option('registry', {
					type: 'string' as const,
					describe: 'Registry URL (e.g. github/myorg/workspaces)',
				}),
		handler: async (argv: { item: string; registry?: string }) => {
			const itemArg = argv.item;

			// Parse the item spec — if it includes a registry prefix, extract it
			// jsrepo items can be: "github/org/repo/item" or just "item" with --registry
			const registryUrl = argv.registry ?? extractRegistry(itemArg);
			const itemName = argv.registry ? itemArg : extractItemName(itemArg);

			if (!registryUrl) {
				outputError(
					'Could not determine registry. Use --registry or provide a full path like github/myorg/workspaces/my-app',
				);
				process.exitCode = 1;
				return;
			}

			console.log(`Resolving ${itemName} from ${registryUrl}...`);

			const cwd = process.cwd() as AbsolutePath;

			// 1. Resolve registry
			const registriesResult = await resolveRegistries([registryUrl], {
				cwd,
				providers: DEFAULT_PROVIDERS,
			});
			if (registriesResult.isErr()) {
				outputError(`Failed to resolve registry: ${registriesResult.error}`);
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
			const resolved = await resolveWantedItems(parsed.value.wantedItems, {
				resolvedRegistries: registriesResult.value,
				nonInteractive: true,
			});
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
			const wsDir = join(workspacesDir(home), item.name);

			// Check for existing
			if (await Bun.file(join(wsDir, 'epicenter.config.ts')).exists()) {
				outputError(
					`Workspace "${item.name}" already exists at ${wsDir}. Use "epicenter update" to update it.`,
				);
				process.exitCode = 1;
				return;
			}

			await mkdir(wsDir, { recursive: true });
			await mkdir(join(wsDir, 'data'), { recursive: true });

			// 5. Write files
			for (const file of item.files) {
				const filePath = join(wsDir, file.path);
				await mkdir(dirname(filePath), { recursive: true });
				await Bun.write(filePath, file.content);
			}

			console.log(`Wrote ${item.files.length} file(s)`);

			// 6. Generate package.json from dependencies
			const deps: Record<string, string> = {};
			for (const dep of item.dependencies ?? []) {
				if (typeof dep === 'string') {
					deps[dep] = 'latest';
				} else {
					deps[dep.name] = dep.version ?? 'latest';
				}
			}

			if (Object.keys(deps).length > 0) {
				const pkg = { name: item.name, private: true, dependencies: deps };
				await Bun.write(join(wsDir, 'package.json'), JSON.stringify(pkg, null, 2));
				console.log('Installing dependencies...');
				await $`bun install`.cwd(wsDir).quiet();
			}

			// 7. Write manifest.json with provenance
			const manifest = {
				registry: registryUrl,
				item: item.name,
				installedAt: new Date().toISOString(),
				files: item.files.map((f: { path: string }) => f.path),
			};
			await Bun.write(join(wsDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

			output({
				installed: item.name,
				path: wsDir,
				files: item.files.length,
				dependencies: Object.keys(deps).length,
			});
		},
	};
}

/** Extract registry URL from a full item path like "github/org/repo/item" */
function extractRegistry(itemPath: string): string | undefined {
	// jsrepo format: "provider/org/repo/category/item" or "provider/org/repo/item"
	const parts = itemPath.split('/');
	if (parts.length >= 4) {
		// provider/org/repo is the registry
		return parts.slice(0, 3).join('/');
	}
	return undefined;
}

/** Extract item name from a full item path */
function extractItemName(itemPath: string): string {
	const parts = itemPath.split('/');
	if (parts.length >= 4) {
		// Everything after provider/org/repo is the item spec
		return parts.slice(3).join('/');
	}
	return itemPath;
}
