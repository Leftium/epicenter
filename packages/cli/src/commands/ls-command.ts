import { readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Argv } from 'yargs';
import type { DiscoveredWorkspace } from '../discovery';
import { formatYargsOptions, output } from '../format-output';
import { workspacesDir } from '../paths';

export function buildLsCommand(home: string) {
	return {
		command: 'ls',
		describe: 'List installed workspaces',
		builder: (y: Argv) => y.options(formatYargsOptions()),
		handler: async (argv: { format?: 'json' | 'jsonl' }) => {
			const dir = workspacesDir(home);

			let dirents: import('node:fs').Dirent[];
			try {
				dirents = (await readdir(dir, {
					withFileTypes: true,
				})) as unknown as import('node:fs').Dirent[];
			} catch {
				output([], { format: argv.format });
				return;
			}

			const workspaces: DiscoveredWorkspace[] = [];

			for (const dirent of dirents) {
				const fullPath = join(dir, dirent.name);
				const isSymlink = dirent.isSymbolicLink();
				const configExists = await Bun.file(
					join(fullPath, 'epicenter.config.ts'),
				).exists();
				const hasManifest = await Bun.file(
					join(fullPath, 'manifest.json'),
				).exists();

				const resolvedPath = isSymlink
					? await readlink(fullPath).catch(() => fullPath)
					: fullPath;

				const entry: DiscoveredWorkspace & { registry?: string | null } = {
					id: dirent.name,
					type: isSymlink ? 'linked' : 'installed',
					path: resolvedPath,
					status: configExists ? 'ok' : 'error',
				};

				if (!configExists) {
					entry.error = isSymlink
						? 'symlink target not found or missing config'
						: 'missing epicenter.config.ts';
				}

				if (hasManifest) {
					try {
						const manifest = JSON.parse(
							await Bun.file(join(fullPath, 'manifest.json')).text(),
						);
						(entry as Record<string, unknown>).registry =
							manifest.registry ?? null;
					} catch {
						// ignore corrupt manifest
					}
				}

				workspaces.push(entry);
			}

			output(workspaces, { format: argv.format });
		},
	};
}
