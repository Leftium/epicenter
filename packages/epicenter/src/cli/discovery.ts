import { join, resolve } from 'node:path';
import type { ProjectDir } from '../shared/types';
import type { WorkspaceClient } from '../static/types';

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTED TYPES
// ═══════════════════════════════════════════════════════════════════════════

// biome-ignore lint/suspicious/noExplicitAny: WorkspaceClient is generic over tables/kv/capabilities
export type AnyWorkspaceClient = WorkspaceClient<any, any, any, any>;

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
	const subdirConfigs = await findSubdirConfigs(baseDir);
	if (subdirConfigs.length > 0) {
		return { status: 'ambiguous', configs: subdirConfigs };
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

async function loadClientFromPath(
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

async function findSubdirConfigs(baseDir: string): Promise<string[]> {
	// */** pattern naturally excludes root-level matches
	const glob = new Bun.Glob(`*/**/${CONFIG_FILENAME}`);
	const configs: string[] = [];

	for await (const path of glob.scan({ cwd: baseDir, onlyFiles: true })) {
		configs.push(path);
	}

	return configs.sort();
}

function isWorkspaceClient(value: unknown): value is AnyWorkspaceClient {
	return (
		typeof value === 'object' &&
		value !== null &&
		'id' in value &&
		'tables' in value &&
		typeof (value as Record<string, unknown>).id === 'string'
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// DEPRECATED EXPORTS (for backwards compatibility)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Use resolveWorkspace() for full resolution with ambiguity detection.
 */
export async function findProjectDir(
	dir: string = process.cwd(),
): Promise<ProjectDir | null> {
	const resolved = resolve(dir);
	if (await Bun.file(join(resolved, CONFIG_FILENAME)).exists()) {
		return resolved as ProjectDir;
	}
	return null;
}

/**
 * @deprecated Use resolveWorkspace() which combines discovery and loading.
 */
export async function loadClient(
	projectDir: ProjectDir,
): Promise<AnyWorkspaceClient> {
	const configPath = join(projectDir, CONFIG_FILENAME);
	return loadClientFromPath(configPath);
}
