import type { AnyWorkspaceClient } from '@epicenter/hq/static';
import { Elysia } from 'elysia';
import { createActionsRouter } from './actions';
import { createTablesPlugin } from './tables';

/**
 * Create an Elysia plugin that bundles tables + actions for workspace clients.
 *
 * Does NOT include sync (that's a separate plugin), OpenAPI (added by createServer),
 * or the discovery `GET /` endpoint (added by createServer).
 * Provides REST CRUD for all tables and action endpoints per workspace.
 *
 * @example
 * ```typescript
 * import { createWorkspacePlugin } from '@epicenter/server';
 * import { createSyncPlugin } from '@epicenter/server/sync';
 *
 * const app = new Elysia()
 *   .use(createSyncPlugin({ getDoc: (room) => workspaces[room]?.ydoc }))
 *   .use(createWorkspacePlugin(clients))
 *   .listen(3913);
 * ```
 */
export function createWorkspacePlugin(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];

	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	const app = new Elysia().use(createTablesPlugin(workspaces));

	// Mount action routers per workspace
	for (const client of clients) {
		if (!client.actions) continue;
		app.use(
			createActionsRouter({
				actions: client.actions,
				basePath: `/${client.id}/actions`,
			}),
		);
	}

	return app;
}
