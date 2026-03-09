import type {
	AnyWorkspaceClient,
	BaseRow,
	TableHelper,
} from '@epicenter/workspace';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { WorkspaceApiError } from './errors';

function resolveTable(
	workspaces: Record<string, AnyWorkspaceClient>,
	workspaceId: string,
	tableName: string,
): TableHelper<BaseRow> | undefined {
	const workspace = workspaces[workspaceId];
	if (!workspace) return undefined;
	return (workspace.tables as Record<string, TableHelper<BaseRow>>)[tableName];
}

/**
 * Create a Hono router that exposes CRUD routes for all workspace tables.
 * Registers GET (list/get-by-id), PUT (create/replace), PATCH (partial update),
 * and DELETE routes for each table name found across all workspaces.
 * @param workspaces - Map of workspace ID to workspace client.
 * @returns A Hono router with routes under `/:workspaceId/tables`.
 */
export function createTablesPlugin(
	workspaces: Record<string, AnyWorkspaceClient>,
) {
	const tableNames = new Set<string>();
	for (const workspace of Object.values(workspaces)) {
		for (const name of Object.keys(workspace.definitions.tables)) {
			tableNames.add(name);
		}
	}

	const router = new Hono();

	for (const tableName of tableNames) {
		router.get(
			`/:workspaceId/tables/${tableName}`,
			describeRoute({
				description: `List all rows in the ${tableName} table`,
				tags: [tableName, 'tables'],
			}),
			(c) => {
				const tableHelper = resolveTable(
					workspaces,
					c.req.param('workspaceId'),
					tableName,
				);
				if (!tableHelper)
					return c.json(WorkspaceApiError.TableNotFound().error, 404);
				return c.json(tableHelper.getAllValid());
			},
		);

		router.get(
			`/:workspaceId/tables/${tableName}/:id`,
			describeRoute({
				description: `Get a row by ID from the ${tableName} table`,
				tags: [tableName, 'tables'],
			}),
			(c) => {
				const tableHelper = resolveTable(
					workspaces,
					c.req.param('workspaceId'),
					tableName,
				);
				if (!tableHelper)
					return c.json(WorkspaceApiError.TableNotFound().error, 404);
				const result = tableHelper.get(c.req.param('id'));
				if (result.status === 'not_found') return c.json(result, 404);
				if (result.status === 'invalid') return c.json(result, 422);
				return c.json(result);
			},
		);

		router.put(
			`/:workspaceId/tables/${tableName}/:id`,
			describeRoute({
				description: `Create or replace a row by ID in the ${tableName} table`,
				tags: [tableName, 'tables'],
			}),
			async (c) => {
				const tableHelper = resolveTable(
					workspaces,
					c.req.param('workspaceId'),
					tableName,
				);
				if (!tableHelper)
					return c.json(WorkspaceApiError.TableNotFound().error, 404);
				const body = await c.req.json();
				const result = tableHelper.parse(c.req.param('id'), body);
				if (result.status === 'invalid') return c.json(result, 422);
				tableHelper.set(result.row);
				return c.json(result);
			},
		);

		router.patch(
			`/:workspaceId/tables/${tableName}/:id`,
			describeRoute({
				description: `Partially update a row by ID in the ${tableName} table`,
				tags: [tableName, 'tables'],
			}),
			async (c) => {
				const tableHelper = resolveTable(
					workspaces,
					c.req.param('workspaceId'),
					tableName,
				);
				if (!tableHelper)
					return c.json(WorkspaceApiError.TableNotFound().error, 404);
				const body = await c.req.json();
				const result = tableHelper.update(
					c.req.param('id'),
					body as Partial<Omit<BaseRow, 'id'>>,
				);
				if (result.status === 'not_found') return c.json(result, 404);
				if (result.status === 'invalid') return c.json(result, 422);
				return c.json(result);
			},
		);

		router.delete(
			`/:workspaceId/tables/${tableName}/:id`,
			describeRoute({
				description: `Delete a row by ID from the ${tableName} table`,
				tags: [tableName, 'tables'],
			}),
			(c) => {
				const tableHelper = resolveTable(
					workspaces,
					c.req.param('workspaceId'),
					tableName,
				);
				if (!tableHelper)
					return c.json(WorkspaceApiError.TableNotFound().error, 404);
				return c.json(tableHelper.delete(c.req.param('id')));
			},
		);
	}

	return router;
}
