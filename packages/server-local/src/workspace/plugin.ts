import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { collectActionPaths, createActionsPlugin } from './actions';
import { WorkspaceApiError } from './errors';
import { createKvPlugin } from './kv';
import { createTablesPlugin } from './tables';

/**
 * Create a Hono app that bundles tables + KV + actions for workspace clients.
 *
 * Uses parameterized routes (`/:workspaceId/tables/:tableName`, etc.) so that
 * workspace and table resolution happens at request time via the workspaces map.
 *
 * Mount under `/workspaces` (or any prefix) via Hono:
 *
 * @example
 * ```typescript
 * const app = new Hono()
 *   .route('/workspaces', createWorkspacePlugin(clients))
 *   .listen(3913);
 * ```
 */
export function createWorkspacePlugin(clients: AnyWorkspaceClient[]) {
	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	const app = new Hono().get(
		'/:workspaceId',
		describeRoute({
			description: 'Get workspace metadata',
			tags: ['workspaces'],
		}),
		(c) => {
			const workspace = workspaces[c.req.param('workspaceId')];
			if (!workspace)
				return c.json(WorkspaceApiError.WorkspaceNotFound().error, 404);
			return c.json({
				id: workspace.id,
				tables: Object.keys(workspace.definitions.tables),
				kv: Object.keys(workspace.definitions.kv ?? {}),
				actions: workspace.actions ? collectActionPaths(workspace.actions) : [],
			});
		},
	);

	app.route('/', createTablesPlugin(workspaces));
	app.route('/', createKvPlugin(workspaces));
	app.route('/', createActionsPlugin(workspaces));

	return app;
}
