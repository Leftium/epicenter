/**
 * Workspace config loader.
 *
 * Loads `epicenter.config.ts` and collects all `WorkspaceClient` exports
 * (results of `createWorkspace()`). Treats default and named exports
 * uniformly—all valid clients are returned.
 *
 * @example
 * ```typescript
 * // epicenter.config.ts:
 * //   export default createWorkspace(defineWorkspace({ id: 'my-app', ... }));
 * //   — or —
 * //   export const notes = createNotesWorkspace();
 * //   export const tasks = createTasksWorkspace();
 *
 * const { clients } = await loadConfig('/path/to/project');
 * ```
 */

import { join, resolve } from 'node:path';
import type { AnyWorkspaceClient } from '@epicenter/workspace';

const CONFIG_FILENAME = 'epicenter.config.ts';

export type LoadConfigResult = {
	/** Absolute path to the directory containing epicenter.config.ts. */
	configDir: string;
	/** Workspace clients loaded from the config. */
	clients: AnyWorkspaceClient[];
};

/**
 * Load workspace clients from an epicenter.config.ts file.
 *
 * Collects all exports (default + named) that pass the workspace client
 * duck-type check. Deduplicates by workspace ID.
 *
 * @param targetDir - Directory containing epicenter.config.ts.
 * @throws If no config file found or no valid exports detected.
 */
export async function loadConfig(targetDir: string): Promise<LoadConfigResult> {
	const configDir = resolve(targetDir);
	const configPath = join(configDir, CONFIG_FILENAME);

	if (!(await Bun.file(configPath).exists())) {
		throw new Error(`No ${CONFIG_FILENAME} found in ${configDir}`);
	}

	const module = await import(Bun.pathToFileURL(configPath).href);

	const clients: AnyWorkspaceClient[] = [];
	const seenIds = new Set<string>();

	// Object.entries includes `default` as a key for ESM imports.
	// No special-casing needed—collect everything that's a workspace client.
	for (const [name, value] of Object.entries(module)) {
		if (!isWorkspaceClient(value)) continue;

		if (seenIds.has(value.id)) {
			throw new Error(
				`Duplicate workspace ID "${value.id}" found in ${CONFIG_FILENAME} (export "${name}")`,
			);
		}
		seenIds.add(value.id);
		clients.push(value);
	}

	if (clients.length === 0) {
		throw new Error(
			`No workspace clients found in ${CONFIG_FILENAME}.\n` +
				`Export createWorkspace() results:\n` +
				`  export default createWorkspace(defineWorkspace({...}))\n` +
				`  export const myApp = createMyWorkspace()`,
		);
	}

	return { configDir, clients };
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** A pre-wired client has `definitions` and `tables` (set by createWorkspace). */
function isWorkspaceClient(value: unknown): value is AnyWorkspaceClient {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.id === 'string' &&
		'definitions' in record &&
		'tables' in record
	);
}
