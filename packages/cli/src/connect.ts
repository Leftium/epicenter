import { filesystemPersistence } from '@epicenter/workspace/extensions/persistence/sqlite';
import { createSyncExtension } from '@epicenter/workspace/extensions/sync/websocket';
import { createSessionStore } from './auth/store.js';
import { createCliUnlock } from './extensions.js';
import { EPICENTER_PATHS } from './paths.js';
import type {
	AwarenessDefinitions,
	KvDefinitions,
	TableDefinitions,
	WorkspaceClientBuilder,
} from '@epicenter/workspace';

/**
 * Connect a workspace factory to the Epicenter API with authentication,
 * persistence, and sync — ready to use in one `await`.
 *
 * Chains extensions in the correct order (persistence → unlock → sync),
 * waits for local persistence to load, then waits for the WebSocket sync
 * to reach `connected` phase. The returned workspace has both local and
 * remote data.
 *
 * Persistence is stored at `~/.epicenter/persistence/<workspace-id>.db`.
 *
 * Requires a prior `epicenter auth login` to store session credentials at
 * `~/.epicenter/auth/sessions.json`.
 *
 * @param factory - Workspace factory function (e.g. `createFujiWorkspace`).
 *   Must return a workspace builder — typically `createWorkspace(def).withActions(...)`.
 * @param opts.server - Epicenter API server URL. Defaults to
 *   `process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so'`.
 *
 * @example
 * ```typescript
 * import { connectWorkspace } from '@epicenter/cli';
 * import { createFujiWorkspace } from '@epicenter/fuji/workspace';
 *
 * const workspace = await connectWorkspace(createFujiWorkspace);
 *
 * // Safe to read — has both local persistence and remote sync data
 * const entries = workspace.tables.entries.filter(e => !e.deletedAt);
 * for (const entry of entries) {
 *   workspace.tables.entries.update(entry.id, { tags: [...entry.tags, 'Journal'] });
 * }
 *
 * await workspace.dispose();
 * ```
 */
export async function connectWorkspace<
	T extends WorkspaceClientBuilder<
		string,
		TableDefinitions,
		KvDefinitions,
		AwarenessDefinitions
	>,
>(
	factory: () => T,
	{
		server = process.env.EPICENTER_SERVER ?? 'https://api.epicenter.so',
	}: { server?: string } = {},
) {
	const sessions = createSessionStore();
	const base = factory();

	const client = base
		.withExtension(
			'persistence',
			filesystemPersistence({
				filePath: EPICENTER_PATHS.persistence(base.id),
			}),
		)
		.withWorkspaceExtension('unlock', createCliUnlock(sessions, server))
		.withExtension(
			'sync',
			createSyncExtension({
				url: (docId) => `${server}/workspaces/${docId}`,
				getToken: async () =>
					(await sessions.load(server))?.accessToken ?? null,
			}),
		);

	await client.whenReady;
	await client.extensions.sync.whenConnected;
	return client;
}
