import { join, resolve } from 'node:path';
import type { AnyWorkspaceClient, ProjectDir } from '@epicenter/workspace';

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTED TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type { AnyWorkspaceClient };

export type WorkspaceResolution =
	| { status: 'found'; projectDir: ProjectDir; client: AnyWorkspaceClient }
	| { status: 'ambiguous'; configs: string[] }
	| { status: 'not_found' };

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

export async function loadClientFromPath(
	configPath: string,
): Promise<AnyWorkspaceClient> {
	const module = await import(Bun.pathToFileURL(configPath).href);

	// New convention: export default createWorkspaceClient({...})
	if (module.default !== undefined) {
		const client = module.default;
		if (isWorkspaceClient(client)) {
			return client;
		}
		throw new Error(
			`Default export in ${CONFIG_FILENAME} is not a WorkspaceClient.\n` +
				`Expected: export default createWorkspaceClient({...})\n` +
				`Got: ${typeof client}`,
		);
	}

	// Fallback: support old convention of named exports (for migration)
	const exports = Object.entries(module);
	const clients = exports.filter(([, value]) => isWorkspaceClient(value));

	if (clients.length === 0) {
		throw new Error(
			`No WorkspaceClient found in ${CONFIG_FILENAME}.\n` +
				`Expected: export default createWorkspaceClient({...})`,
		);
	}

	if (clients.length > 1) {
		const names = clients.map(([name]) => name).join(', ');
		throw new Error(
			`Multiple WorkspaceClient exports found: ${names}\n` +
				`Epicenter supports one workspace per config. Use: export default createWorkspaceClient({...})`,
		);
	}

	return clients[0]![1] as AnyWorkspaceClient;
}

function isWorkspaceClient(value: unknown): value is AnyWorkspaceClient {
	return (
		typeof value === 'object' &&
		value !== null &&
		'id' in value &&
		'tables' in value &&
		'definitions' in value &&
		typeof (value as Record<string, unknown>).id === 'string'
	);
}
