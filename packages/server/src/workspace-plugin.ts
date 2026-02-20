import type { AnyWorkspaceClient } from '@epicenter/hq/static';
import { Elysia } from 'elysia';
import { createActionsRouter } from './actions';
import { createTablesPlugin } from './tables';

/**
 * Create an Elysia plugin that bundles tables + actions for workspace clients.
 *
 * Self-hosted only. Provides REST CRUD for all tables and action endpoints per workspace.
 * For cloud deployments, use the sync plugin directly — table access is via CRDTs
 * and actions run on the user's own infrastructure.
 *
 * Each workspace is mounted under its own prefix (`/{workspaceId}`), so this plugin
 * is itself prefix-agnostic. Mount it under `/workspaces` (or any prefix) via Elysia:
 *
 * @example
 * ```typescript
 * import { createWorkspacePlugin } from '@epicenter/server';
 * import { createSyncPlugin } from '@epicenter/server/sync';
 *
 * const app = new Elysia({ prefix: '/workspaces' })
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

	const app = new Elysia();

	for (const client of clients) {
		const workspaceApp = new Elysia({ prefix: `/${client.id}` });

		// Tables: /tables/:table, /tables/:table/:id
		workspaceApp.use(createTablesPlugin(client));

		// Actions: /actions/:path
		if (client.actions) {
			workspaceApp.use(createActionsRouter(client.actions));
		}

		app.use(workspaceApp);
	}

	return app;
}
