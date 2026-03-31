/**
 * Open a workspace from disk with persistence only (no sync).
 *
 * Used by `data` commands to read/write workspace data directly.
 * The config must export pre-wired `createWorkspace()` clients.
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

import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { loadConfig } from '../load-config';

export type OpenWorkspaceOptions = {
	/** Directory containing epicenter.config.ts. */
	dir: string;
	/** Workspace ID to open (required if config has multiple workspaces). */
	workspaceId?: string;
};

export type OpenWorkspaceResult = {
	/** The workspace client loaded from config. */
	client: AnyWorkspaceClient;
	/** Config directory path. */
	configDir: string;
	/** Gracefully close the workspace (flush persistence). */
	dispose: () => Promise<void>;
};

/**
 * Open a workspace from disk.
 *
 * Loads the config, finds the requested workspace, waits for ready,
 * and returns the client.
 */
export async function openWorkspaceFromDisk(
	options: OpenWorkspaceOptions,
): Promise<OpenWorkspaceResult> {
	const { configDir, clients } = await loadConfig(options.dir);

	let client: AnyWorkspaceClient;

	if (options.workspaceId) {
		const found = clients.find((c) => c.id === options.workspaceId);
		if (!found) {
			const ids = clients.map((c) => c.id).join(', ');
			throw new Error(
				`Workspace "${options.workspaceId}" not found. Available: ${ids}`,
			);
		}
		client = found;
	} else if (clients.length === 1) {
		client = clients[0]!;
	} else {
		const ids = clients.map((c) => c.id).join(', ');
		throw new Error(
			`Multiple workspaces found. Specify one with --workspace: ${ids}`,
		);
	}

	await client.whenReady;

	return {
		client,
		configDir,
		dispose: () => client.dispose(),
	};
}

/**
 * Run an operation against a workspace, handling the full open/use/destroy lifecycle.
 *
 * Opens the workspace from disk, passes the client to the callback,
 * then destroys the client (flushes persistence) regardless of success or failure.
 *
 * @example
 * ```typescript
 * const notes = await withWorkspace({ dir: '.' }, (client) => {
 *   return client.tables.notes.getAllValid();
 * });
 * ```
 */
export async function withWorkspace<T>(
	options: OpenWorkspaceOptions,
	fn: (client: AnyWorkspaceClient) => T | Promise<T>,
): Promise<T> {
	const { client, dispose } = await openWorkspaceFromDisk(options);
	try {
		const result = await fn(client);
		return result;
	} finally {
		await dispose();
	}
}
