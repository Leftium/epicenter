import { dirname, join, resolve } from 'node:path';
import type { ProjectDir } from '../shared/types';
import type { WorkspaceClient } from '../static/types';

// biome-ignore lint/suspicious/noExplicitAny: WorkspaceClient is generic over tables/kv/capabilities
export type AnyWorkspaceClient = WorkspaceClient<any, any, any, any>;

const CONFIG_FILENAME = 'epicenter.config.ts';

/**
 * Check if a config file exists in the given directory (no upward traversal).
 */
export async function findProjectDir(
	dir: string = process.cwd(),
): Promise<ProjectDir | null> {
	const resolved = resolve(dir);
	const configPath = join(resolved, CONFIG_FILENAME);

	if (await fileExists(configPath)) {
		return resolved as ProjectDir;
	}

	return null;
}

/**
 * Find all epicenter.config.ts files in subdirectories of the given directory.
 * Uses Bun.Glob for efficient filesystem traversal.
 */
export async function findConfigsInSubdirs(dir: string): Promise<string[]> {
	const resolved = resolve(dir);
	const glob = new Bun.Glob(`**/${CONFIG_FILENAME}`);

	const configs: string[] = [];

	for await (const path of glob.scan({
		cwd: resolved,
		onlyFiles: true,
		absolute: false,
	})) {
		// Get the directory containing the config (relative to search dir)
		const configDir = dirname(path) || '.';
		if (configDir !== '.') {
			// Only include subdirectory configs, not the root
			configs.push(path);
		}
	}

	return configs.sort();
}

async function fileExists(path: string): Promise<boolean> {
	return Bun.file(path).exists();
}

export async function loadClient(
	projectDir: ProjectDir,
): Promise<AnyWorkspaceClient> {
	const configPath = join(projectDir, CONFIG_FILENAME);

	if (!(await fileExists(configPath))) {
		throw new Error(`No ${CONFIG_FILENAME} found at ${configPath}`);
	}

	const module = await import(configPath);
	const clients = Object.values(module).filter(isWorkspaceClient);

	if (clients.length === 0) {
		throw new Error(
			`No WorkspaceClient exports found in ${CONFIG_FILENAME}.\n` +
				`Export a client as: export const workspace = createWorkspaceClient({...})`,
		);
	}

	if (clients.length > 1) {
		throw new Error(
			`Found ${clients.length} WorkspaceClient exports. Epicenter supports one workspace per config file.\n` +
				`Use separate directories for multiple workspaces.`,
		);
	}

	return clients[0]!;
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
