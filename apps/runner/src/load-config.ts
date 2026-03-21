/**
 * Load workspace definitions and pre-wired clients from an epicenter.config.ts file.
 *
 * Mirrors the dynamic import pattern from packages/cli/src/discovery.ts but collects
 * raw WorkspaceDefinitions (for auto-wiring) alongside pre-wired WorkspaceClients
 * (for passthrough lifecycle management).
 */

import { join, resolve } from 'node:path';
import type { AnyWorkspaceClient, WorkspaceDefinition } from '@epicenter/workspace';

const CONFIG_FILENAME = 'epicenter.config.ts';

/**
 * Broadest WorkspaceDefinition—erases table/kv generics for dynamic import use.
 * Equivalent to `WorkspaceDefinition<string, any, any, any>`.
 */
// biome-ignore lint/suspicious/noExplicitAny: intentional variance-friendly type for dynamic imports
type AnyWorkspaceDefinition = WorkspaceDefinition<string, any, any, any>;

export type LoadConfigResult = {
	configDir: string;
	definitions: AnyWorkspaceDefinition[];
	clients: AnyWorkspaceClient[];
};

/**
 * Load epicenter.config.ts from the target directory.
 *
 * Detects each named export as either:
 * - WorkspaceDefinition (has `id`, lacks `definitions`) → needs extension wiring
 * - WorkspaceClient (has `id` and `definitions`) → already wired, passthrough
 *
 * @example
 * ```typescript
 * const { configDir, definitions, clients } = await loadConfig('/path/to/project');
 * ```
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

	for (const [name, value] of Object.entries(module)) {
		if (name === 'default' || typeof value !== 'object' || value === null) {
			continue;
		}

		const record = value as Record<string, unknown>;
		if (typeof record.id !== 'string') continue;

		// Duplicate ID check
		if (seenIds.has(record.id)) {
			throw new Error(
				`Duplicate workspace ID "${record.id}" found in ${CONFIG_FILENAME}`,
			);
		}
		seenIds.add(record.id);

		if (isWorkspaceClient(record)) {
			clients.push(value as AnyWorkspaceClient);
		} else if (isWorkspaceDefinition(record)) {
			definitions.push(value as AnyWorkspaceDefinition);
		}
	}

	if (definitions.length === 0 && clients.length === 0) {
		throw new Error(`No workspace definitions found in ${CONFIG_FILENAME}`);
	}

	return { configDir, definitions, clients };
}

/** A pre-wired client has `definitions` (set by createWorkspace). */
function isWorkspaceClient(value: Record<string, unknown>): boolean {
	return 'id' in value && 'definitions' in value && 'tables' in value;
}

/** A raw definition has `id` but no `definitions` property. */
function isWorkspaceDefinition(value: Record<string, unknown>): boolean {
	return 'id' in value && !('definitions' in value);
}
