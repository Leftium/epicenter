import { type } from 'arktype';
import { Elysia } from 'elysia';
import { Ok } from 'wellcrafted/result';
import { Id, tableToArktype } from '../dynamic/schema';
import type { WorkspaceClient } from '../dynamic/workspace/types';

// biome-ignore lint/suspicious/noExplicitAny: WorkspaceClient is generic over tables/kv/extensions
type AnyWorkspaceClient = WorkspaceClient<any, any, any>;

export function createTablesPlugin(
	workspaceClients: Record<string, AnyWorkspaceClient>,
) {
	const app = new Elysia();

	for (const [workspaceId, workspace] of Object.entries(workspaceClients)) {
		for (const tableName of Object.keys(workspace.tables.definitions)) {
			const tableHelper = workspace.tables.get(tableName);
			const fields = workspace.tables.definitions[tableName]!.fields;
			const basePath = `/workspaces/${workspaceId}/tables/${tableName}`;
			const tags = [workspaceId, 'tables'];

			app.get(basePath, () => tableHelper.getAllValid(), {
				detail: { description: `List all ${tableName}`, tags },
			});

			app.get(
				`${basePath}/:id`,
				({ params, status }) => {
					const result = tableHelper.get(Id(params.id));

					switch (result.status) {
						case 'valid':
							return result.row;
						case 'invalid':
							return status(422, { errors: result.errors });
						case 'not_found':
							return status(404, { error: 'Not found' });
					}
				},
				{
					detail: { description: `Get ${tableName} by ID`, tags },
				},
			);

			app.post(
				basePath,
				({ body }) => {
					tableHelper.upsert(body as { id: Id });
					return Ok({ id: (body as { id: string }).id });
				},
				{
					body: tableToArktype(fields),
					detail: { description: `Create or update ${tableName}`, tags },
				},
			);

			app.put(
				`${basePath}/:id`,
				({ params, body }) => {
					const result = tableHelper.update({
						id: Id(params.id),
						...(body as Record<string, unknown>),
					});
					return Ok(result);
				},
				{
					body: tableToArktype(fields).partial().merge({ id: type.string }),
					detail: { description: `Update ${tableName} by ID`, tags },
				},
			);

			app.delete(
				`${basePath}/:id`,
				({ params }) => {
					const result = tableHelper.delete(Id(params.id));
					return Ok(result);
				},
				{
					detail: { description: `Delete ${tableName} by ID`, tags },
				},
			);
		}
	}

	return app;
}
