import { mkdir, readdir, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AnyWorkspaceClient, ProjectDir } from '@epicenter/workspace';
import { loadClientFromPath } from './config/load-config';
import { workspacesDir } from './paths';

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTED TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type { AnyWorkspaceClient };

export type WorkspaceResolution =
	| { status: 'found'; projectDir: ProjectDir; client: AnyWorkspaceClient }
	| { status: 'ambiguous'; configs: string[] }
	| { status: 'not_found' };

export type DiscoveredWorkspace = {
	id: string;
	type: 'installed' | 'linked';
	path: string;
	status: 'ok' | 'error';
	error?: string;
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG_FILENAME = 'epicenter.config.ts';

/**
 * Resolve and load a workspace from a directory.
 *
 * 1. Checks for config in the given directory
 * 2. If not found, checks subdirectories for ambiguity detection
 * 3. Loads and validates the client if found
 */
export async function resolveWorkspace(
	dir: string = process.cwd(),
): Promise<WorkspaceResolution> {
	const baseDir = resolve(dir);
	const configPath = join(baseDir, CONFIG_FILENAME);

	// Check for config in the specified directory
	if (await Bun.file(configPath).exists()) {
		const client = await loadClientFromPath(configPath);
		return { status: 'found', projectDir: baseDir as ProjectDir, client };
	}

	// No config in target dir - check subdirs for helpful error message
	const glob = new Bun.Glob(`*/**/${CONFIG_FILENAME}`);
	const configs: string[] = [];
	for await (const path of glob.scan({ cwd: baseDir, onlyFiles: true })) {
		configs.push(path);
	}
	configs.sort();

	if (configs.length > 0) {
		return { status: 'ambiguous', configs };
	}

	return { status: 'not_found' };
}

/**
 * Check if a directory contains an epicenter config.
 */
export async function hasConfig(dir: string): Promise<boolean> {
	return Bun.file(join(resolve(dir), CONFIG_FILENAME)).exists();
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Discover all workspaces from one or more directories.
 *
 * For each directory:
 * 1. If it contains an epicenter.config.ts, load it
 * 2. Otherwise, scan one level deep for workspace configs
 *
 * Throws on duplicate workspace IDs.
 */
export async function discoverAllWorkspaces(
	dirs: string[] = [process.cwd()],
): Promise<{ clients: AnyWorkspaceClient[]; sources: Map<string, string> }> {
	const clients: AnyWorkspaceClient[] = [];
	const sources = new Map<string, string>(); // id → config path

	for (const dir of dirs) {
		const baseDir = resolve(dir);
		const configPath = join(baseDir, CONFIG_FILENAME);

		// Check for config in this directory
		if (await Bun.file(configPath).exists()) {
			const client = await loadClientFromPath(configPath);
			if (sources.has(client.id)) {
				throw new Error(
					`Duplicate workspace ID "${client.id}" found:\n` +
						`  - ${sources.get(client.id)}\n` +
						`  - ${configPath}\n` +
						`Each workspace must have a unique ID.`,
				);
			}
			sources.set(client.id, configPath);
			clients.push(client);
			continue;
		}

		// Scan one level deep for workspace configs
		const glob = new Bun.Glob(`*/${CONFIG_FILENAME}`);
		for await (const path of glob.scan({ cwd: baseDir, onlyFiles: true })) {
			const fullPath = join(baseDir, path);
			const client = await loadClientFromPath(fullPath);
			if (sources.has(client.id)) {
				throw new Error(
					`Duplicate workspace ID "${client.id}" found:\n` +
						`  - ${sources.get(client.id)}\n` +
						`  - ${fullPath}\n` +
						`Each workspace must have a unique ID.`,
				);
			}
			sources.set(client.id, fullPath);
			clients.push(client);
		}
	}

	return { clients, sources };
}

/**
 * Discover workspaces from $EPICENTER_HOME/workspaces/.
 *
 * Scans the centralized workspaces directory via a single readdir().
 * Follows symlinks transparently. Gracefully skips broken entries.
 */
export async function discoverWorkspaces(home: string): Promise<{
	clients: AnyWorkspaceClient[];
	sources: Map<string, string>;
	discovered: DiscoveredWorkspace[];
}> {
	const dir = workspacesDir(home);
	await mkdir(dir, { recursive: true });

	const dirents = await readdir(dir, { withFileTypes: true });
	const clients: AnyWorkspaceClient[] = [];
	const sources = new Map<string, string>();
	const discovered: DiscoveredWorkspace[] = [];

	for (const dirent of dirents) {
		const fullPath = join(dir, dirent.name);
		const isSymlink = dirent.isSymbolicLink();
		const configPath = join(fullPath, CONFIG_FILENAME);

		const configExists = await Bun.file(configPath).exists();
		if (!configExists) {
			discovered.push({
				id: dirent.name,
				type: isSymlink ? 'linked' : 'installed',
				path: isSymlink
					? await readlink(fullPath).catch(() => fullPath)
					: fullPath,
				status: 'error',
				error: isSymlink
					? 'symlink target not found or missing config'
					: 'missing epicenter.config.ts',
			});
			continue;
		}

		try {
			const client = await loadClientFromPath(configPath);
			if (sources.has(client.id)) {
				throw new Error(
					`Duplicate workspace ID "${client.id}" found:\n` +
						`  - ${sources.get(client.id)}\n` +
						`  - ${configPath}\n` +
						`Each workspace must have a unique ID.`,
				);
			}
			sources.set(client.id, configPath);
			clients.push(client);
			discovered.push({
				id: client.id,
				type: isSymlink ? 'linked' : 'installed',
				path: isSymlink
					? await readlink(fullPath).catch(() => fullPath)
					: fullPath,
				status: 'ok',
			});
		} catch (err) {
			console.error(`Failed to load workspace "${dirent.name}": ${err}`);
			discovered.push({
				id: dirent.name,
				type: isSymlink ? 'linked' : 'installed',
				path: isSymlink
					? await readlink(fullPath).catch(() => fullPath)
					: fullPath,
				status: 'error',
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { clients, sources, discovered };
}

// Re-export from unified config loader for backward compatibility.
export { loadClientFromPath } from './config/load-config';
