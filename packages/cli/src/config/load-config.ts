/**
 * Workspace config loader.
 *
 * Loads `epicenter.config.ts` and collects all `WorkspaceClient` exports
 * (results of `createWorkspace()`). Raw `defineWorkspace()` definitions
 * are not supported—the config must export fully-wired clients.
 *
 * Rules:
 * 1. If a valid `default` export exists, use only that (single workspace).
 * 2. Otherwise, collect all valid named exports (multi-workspace).
 * 3. Duplicate ID detection.
 *
 * @example
 * ```typescript
 * // Single workspace (default export)
 * // epicenter.config.ts:
 * //   export default createWorkspace(defineWorkspace({ id: 'my-app', tables: { ... } }));
 *
 * const result = await loadConfig('/path/to/project');
 * // result.clients = [{ id: 'my-app', ... }]
 *
 * // Multi-workspace (named exports)
 * // epicenter.config.ts:
 * //   export const notes = createNotesWorkspace();
 * //   export const tasks = createTasksWorkspace();
 *
 * const result = await loadConfig('/path/to/project');
 * // result.clients = [{ id: 'notes', ... }, { id: 'tasks', ... }]
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
 * Convention:
 * - If a valid `default` export exists, it's the only workspace (single-workspace mode).
 * - Otherwise, all valid named exports are collected (multi-workspace mode).
 * - Each export must be a `WorkspaceClient` (result of `createWorkspace()`).
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

	// Step 1: Check default export first.
	// If valid, use only that — single-workspace convention.
	if (module.default !== undefined) {
		const value = module.default;
		if (isWorkspaceClient(value)) {
			addClient(value, 'default', seenIds, clients);
			return { configDir, clients };
		}
		// default exists but isn't a workspace client — fall through to named exports
	}

	// Step 2: No valid default — collect named exports (multi-workspace).
	for (const [name, value] of Object.entries(module)) {
		if (name === 'default') continue;
		if (!isWorkspaceClient(value)) continue;

		addClient(value, name, seenIds, clients);
	}

	if (clients.length === 0) {
		throw new Error(
			`No workspace clients found in ${CONFIG_FILENAME}.\n` +
				`Expected: export default createWorkspace(defineWorkspace({...}))\n` +
				`Or named exports: export const myApp = createWorkspace(defineWorkspace({...}))`,
		);
	}

	return { configDir, clients };
}

/**
 * Load a single workspace client from a config path.
 *
 * Used by CLI commands that need a `WorkspaceClient` (e.g. workspace export).
 * The config must export a `createWorkspace()` result.
 */
export async function loadClientFromPath(
	configPath: string,
): Promise<AnyWorkspaceClient> {
	const module = await import(Bun.pathToFileURL(configPath).href);

	// Prefer default export
	if (module.default !== undefined) {
		const client = module.default;
		if (isWorkspaceClient(client)) return client;
		throw new Error(
			`Default export in ${CONFIG_FILENAME} is not a WorkspaceClient.\n` +
				`Expected: export default createWorkspace(defineWorkspace({...}))\n` +
				`Got: ${typeof client}`,
		);
	}

	// Fallback: named exports
	const exports = Object.entries(module);
	const foundClients = exports.filter(([, value]) => isWorkspaceClient(value));

	if (foundClients.length === 0) {
		throw new Error(
			`No WorkspaceClient found in ${CONFIG_FILENAME}.\n` +
				`Expected: export default createWorkspace(defineWorkspace({...}))`,
		);
	}

	if (foundClients.length > 1) {
		const names = foundClients.map(([name]) => name).join(', ');
		throw new Error(
			`Multiple WorkspaceClient exports found: ${names}\n` +
				`Epicenter supports one workspace per config. Use: export default createWorkspace(defineWorkspace({...}))`,
		);
	}

	return foundClients[0]?.[1] as AnyWorkspaceClient;
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

/** Add a client to the list, checking for duplicate IDs. */
function addClient(
	client: AnyWorkspaceClient,
	name: string,
	seenIds: Set<string>,
	clients: AnyWorkspaceClient[],
): void {
	if (seenIds.has(client.id)) {
		throw new Error(
			`Duplicate workspace ID "${client.id}" found in ${CONFIG_FILENAME} (export "${name}")`,
		);
	}
	seenIds.add(client.id);
	clients.push(client);
}
