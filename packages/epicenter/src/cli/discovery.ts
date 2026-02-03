import { join, resolve } from 'node:path';
import type { ProjectDir } from '../shared/types';
import type { WorkspaceClient } from '../static/types';

// biome-ignore lint/suspicious/noExplicitAny: WorkspaceClient is generic over tables/kv/capabilities
export type AnyWorkspaceClient = WorkspaceClient<any, any, any, any>;

const CONFIG_FILENAME = 'epicenter.config.ts';

// ═══════════════════════════════════════════════════════════════════════════
// RESULT TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type WorkspaceResolution =
	| { status: 'found'; projectDir: ProjectDir; client: AnyWorkspaceClient }
	| { status: 'ambiguous'; configs: string[] }
	| { status: 'not_found' };

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function loadClientFromPath(
	configPath: string,
): Promise<AnyWorkspaceClient> {
	// Use Bun.pathToFileURL for correct handling of special characters in paths
	const module = await import(Bun.pathToFileURL(configPath).href);
	const exports = Object.entries(module);
	const clients = exports.filter(([, value]) => isWorkspaceClient(value));

	if (clients.length === 0) {
		throw new Error(
			`No WorkspaceClient found in ${CONFIG_FILENAME}.\n` +
				`Export a client: export const workspace = createWorkspaceClient({...})`,
		);
	}

	if (clients.length > 1) {
		const names = clients.map(([name]) => name).join(', ');
		throw new Error(
			`Multiple WorkspaceClient exports found: ${names}\n` +
				`Epicenter supports one workspace per config. Use separate directories for multiple workspaces.`,
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
// EXPORTED UTILITIES (for special cases / backwards compat)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a directory contains an epicenter config.
 * Prefer resolveWorkspace() for normal CLI flows.
 */
export async function hasConfig(dir: string): Promise<boolean> {
	return Bun.file(join(resolve(dir), CONFIG_FILENAME)).exists();
}

/**
 * Get the project directory if config exists, null otherwise.
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
 * Load a client from a known project directory.
 * @deprecated Use resolveWorkspace() which combines discovery and loading.
 */
export async function loadClient(
	projectDir: ProjectDir,
): Promise<AnyWorkspaceClient> {
	const configPath = join(projectDir, CONFIG_FILENAME);
	return loadClientFromPath(configPath);
}
