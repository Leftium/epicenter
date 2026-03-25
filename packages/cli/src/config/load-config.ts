/**
 * Unified workspace config loader.
 *
 * Merges the old runner config loader and the CLI workspace resolution logic
 * into one function with one set of rules:
 *
 * 1. If a valid `default` export exists, use only that (single workspace).
 * 2. Otherwise, collect all valid named exports (multi-workspace).
 * 3. Classify each export as either:
 *    - `WorkspaceDefinition` (has `id`, no `definitions`) — needs extension wiring
 *    - `WorkspaceClient` (has `id` + `definitions` + `tables`) — already wired
 * 4. Duplicate ID detection.
 *
 * This replaces both:
 * - the old runner config loader (which skipped `default` exports)
 * - the old CLI `loadClientFromPath` implementation (which only returned clients)
 *
 * @example
 * ```typescript
 * // Single workspace (default export)
 * // epicenter.config.ts:
 * //   export default defineWorkspace({ id: 'my-app', tables: { ... } });
 *
 * const result = await loadConfig('/path/to/project');
 * // result.definitions = [{ id: 'my-app', ... }]
 *
 * // Multi-workspace (named exports)
 * // epicenter.config.ts:
 * //   export const notes = defineWorkspace({ id: 'notes', ... });
 * //   export const tasks = defineWorkspace({ id: 'tasks', ... });
 *
 * const result = await loadConfig('/path/to/project');
 * // result.definitions = [{ id: 'notes', ... }, { id: 'tasks', ... }]
 * ```
 */

import { join, resolve } from 'node:path';
import type {
	AnyWorkspaceClient,
	WorkspaceDefinition,
} from '@epicenter/workspace';

const CONFIG_FILENAME = 'epicenter.config.ts';

/**
 * Broadest WorkspaceDefinition — erases table/kv generics for dynamic import use.
 * Equivalent to `WorkspaceDefinition<string, any, any, any>`.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly type for dynamic imports
type AnyWorkspaceDefinition = WorkspaceDefinition<string, any, any, any>;

export type LoadConfigResult = {
	/** Absolute path to the directory containing epicenter.config.ts. */
	configDir: string;
	/** Raw definitions that need extension wiring (persistence + sync). */
	definitions: AnyWorkspaceDefinition[];
	/** Pre-wired clients that already have extensions attached. */
	clients: AnyWorkspaceClient[];
};

/**
 * Load workspace definitions and/or clients from an epicenter.config.ts file.
 *
 * Convention:
 * - If a valid `default` export exists, it's the only workspace (single-workspace mode).
 * - Otherwise, all valid named exports are collected (multi-workspace mode).
 * - Each export is classified as either a raw definition (needs wiring) or a
 *   pre-wired client (passthrough).
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

	const definitions: AnyWorkspaceDefinition[] = [];
	const clients: AnyWorkspaceClient[] = [];
	const seenIds = new Set<string>();

	// Step 1: Check default export first.
	// If valid, use only that — single-workspace convention.
	if (module.default !== undefined) {
		const value = module.default;
		if (isWorkspaceExport(value)) {
			classifyAndAdd(value, 'default', seenIds, definitions, clients);
			return { configDir, definitions, clients };
		}
		// default exists but isn't a workspace — fall through to named exports
	}

	// Step 2: No valid default — collect named exports (multi-workspace).
	for (const [name, value] of Object.entries(module)) {
		if (name === 'default') continue;
		if (typeof value !== 'object' || value === null) continue;
		if (!isWorkspaceExport(value)) continue;

		classifyAndAdd(value, name, seenIds, definitions, clients);
	}

	if (definitions.length === 0 && clients.length === 0) {
		throw new Error(
			`No workspace definitions found in ${CONFIG_FILENAME}.\n` +
				`Expected: export default defineWorkspace({...})\n` +
				`Or named exports: export const myApp = defineWorkspace({...})`,
		);
	}

	return { configDir, definitions, clients };
}

/**
 * Load a single workspace client from a config path.
 *
 * Used by CLI commands that need a `WorkspaceClient` (e.g. workspace export).
 * If the export is a raw definition, this throws because callers expect a
 * fully wired client instance.
 *
 * Preserves backward compatibility with the old `loadClientFromPath` API.
 */
export async function loadClientFromPath(
	configPath: string,
): Promise<AnyWorkspaceClient> {
	const module = await import(Bun.pathToFileURL(configPath).href);

	// Prefer default export
	if (module.default !== undefined) {
		const client = module.default;
		if (isWorkspaceClient(client)) return client;
		// If default is a definition but not a client, we can't use it here
		// since loadClientFromPath expects a fully-wired client
		throw new Error(
			`Default export in ${CONFIG_FILENAME} is not a WorkspaceClient.\n` +
				`Expected: export default createWorkspace({...})\n` +
				`Got: ${typeof client}`,
		);
	}

	// Fallback: named exports
	const exports = Object.entries(module);
	const foundClients = exports.filter(([, value]) => isWorkspaceClient(value));

	if (foundClients.length === 0) {
		throw new Error(
			`No WorkspaceClient found in ${CONFIG_FILENAME}.\n` +
				`Expected: export default createWorkspace({...})`,
		);
	}

	if (foundClients.length > 1) {
		const names = foundClients.map(([name]) => name).join(', ');
		throw new Error(
			`Multiple WorkspaceClient exports found: ${names}\n` +
				`Epicenter supports one workspace per config. Use: export default createWorkspace({...})`,
		);
	}

	return foundClients[0]?.[1] as AnyWorkspaceClient;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/** Check if a value looks like any workspace export (definition or client). */
function isWorkspaceExport(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === 'string';
}

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

/** A raw definition has `id` but no `definitions` property. */
function isWorkspaceDefinition(
	value: unknown,
): value is AnyWorkspaceDefinition {
	if (typeof value !== 'object' || value === null) return false;
	const record = value as Record<string, unknown>;
	return typeof record.id === 'string' && !('definitions' in record);
}

/** Classify an export and add to the appropriate list. */
function classifyAndAdd(
	value: unknown,
	name: string,
	seenIds: Set<string>,
	definitions: AnyWorkspaceDefinition[],
	clients: AnyWorkspaceClient[],
): void {
	const record = value as Record<string, unknown>;
	const id = record.id as string;

	if (seenIds.has(id)) {
		throw new Error(
			`Duplicate workspace ID "${id}" found in ${CONFIG_FILENAME} (export "${name}")`,
		);
	}
	seenIds.add(id);

	if (isWorkspaceClient(value)) {
		clients.push(value);
	} else if (isWorkspaceDefinition(value)) {
		definitions.push(value);
	}
}
