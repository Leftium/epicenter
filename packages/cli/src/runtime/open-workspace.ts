/**
 * Open a workspace from disk with persistence only (no sync).
 *
 * Used by `data` commands to read/write workspace data directly from the
 * SQLite persistence file. Does not connect to any sync server.
 *
 * @example
 * ```typescript
 * const { client, destroy } = await openWorkspaceFromDisk({
 *   dir: '/path/to/project',
 *   workspaceId: 'epicenter.honeycrisp',
 * });
 *
 * const notes = client.tables.notes.getAllValid();
 * await destroy();
 * ```
 */

import { join } from 'node:path';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { createWorkspace } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
import { loadConfig } from '../config/load-config';

export type OpenWorkspaceOptions = {
	/** Directory containing epicenter.config.ts. */
	dir: string;
	/** Workspace ID to open (required if config has multiple workspaces). */
	workspaceId?: string;
};

export type OpenWorkspaceResult = {
	/** The fully-wired workspace client with persistence loaded. */
	client: AnyWorkspaceClient;
	/** Config directory path. */
	configDir: string;
	/** Gracefully close the workspace (flush persistence). */
	destroy: () => Promise<void>;
};

/**
 * Open a workspace from disk with filesystem persistence.
 *
 * Loads the config, finds the requested workspace, wires persistence
 * (no sync), waits for ready, and returns the client.
 *
 * For pre-wired clients (already have extensions), returns as-is.
 * For raw definitions, auto-wires filesystem persistence.
 */
export async function openWorkspaceFromDisk(
	options: OpenWorkspaceOptions,
): Promise<OpenWorkspaceResult> {
	const { configDir, definitions, clients } = await loadConfig(options.dir);

	// Find the requested workspace
	const allEntries = [
		...definitions.map((d) => ({ type: 'definition' as const, value: d })),
		...clients.map((c) => ({ type: 'client' as const, value: c })),
	];

	if (allEntries.length === 0) {
		throw new Error('No workspaces found in config');
	}

	let entry: (typeof allEntries)[number];

	if (options.workspaceId) {
		const found = allEntries.find(
			(e) => (e.value as { id: string }).id === options.workspaceId,
		);
		if (!found) {
			const ids = allEntries
				.map((e) => (e.value as { id: string }).id)
				.join(', ');
			throw new Error(
				`Workspace "${options.workspaceId}" not found. Available: ${ids}`,
			);
		}
		entry = found;
	} else if (allEntries.length === 1) {
		entry = allEntries[0]!;
	} else {
		const ids = allEntries
			.map((e) => (e.value as { id: string }).id)
			.join(', ');
		throw new Error(
			`Multiple workspaces found. Specify one with --workspace: ${ids}`,
		);
	}

	// Wire persistence for raw definitions; passthrough for pre-wired clients
	let client: AnyWorkspaceClient;

	if (entry.type === 'client') {
		client = entry.value as AnyWorkspaceClient;
	} else {
		const definition = entry.value;
		const persistencePath = join(
			configDir,
			'.epicenter',
			'persistence',
			`${definition.id}.db`,
		);
		client = createWorkspace(definition).withExtension(
			'persistence',
			filesystemPersistence({ filePath: persistencePath }),
		);
	}

	await client.whenReady;

	return {
		client,
		configDir,
		destroy: () => client.destroy(),
	};
}
