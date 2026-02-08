import { Elysia } from 'elysia';
import { Ok } from 'wellcrafted/result';
import type { AnyWorkspaceClient, TableHelper } from '../static/types';

export function createTablesPlugin(
	workspaceClients: Record<string, AnyWorkspaceClient>,
) {
	const app = new Elysia();

	for (const [workspaceId, workspace] of Object.entries(workspaceClients)) {
		for (const [tableName, value] of Object.entries(workspace.tables)) {
			const tableHelper = value as TableHelper<{ id: string }>;

			const basePath = `/workspaces/${workspaceId}/tables/${tableName}`;
			const tags = [workspaceId, 'tables'];

			app.get(basePath, () => tableHelper.getAllValid(), {
				detail: { description: `List all ${tableName}`, tags },
			});

			app.get(
				`${basePath}/:id`,
				({ params, status }) => {
					const result = tableHelper.get(params.id);

					switch (result.status) {
						case 'valid':
							return result.row;
						case 'invalid':
							return status('Unprocessable Content', { errors: result.errors });
						case 'not_found':
							return status(404, { error: 'Not found' });
					}
				},
				{
					detail: { description: `Get ${tableName} by ID`, tags },
				},
			);

			app.put(
				`${basePath}/:id`,
				({ params, body, status }) => {
					const result = tableHelper.parse(params.id, body);
					if (result.status === 'invalid')
						return status('Unprocessable Content', { errors: result.errors });
					tableHelper.set(result.row);
					return Ok({ id: params.id });
				},
				{
					detail: { description: `Create or replace ${tableName} by ID`, tags },
				},
			);

			app.patch(
				`${basePath}/:id`,
				({ params, body, status }) => {
					const result = tableHelper.update(
						params.id,
						body as Record<string, unknown>,
					);
					switch (result.status) {
						case 'updated':
							return Ok({ id: result.row.id });
						case 'not_found':
							return status(404, { error: 'Not found' });
						case 'invalid':
							return status('Unprocessable Content', { errors: result.errors });
					}
				},
				{
					detail: { description: `Partial update ${tableName} by ID`, tags },
				},
			);

			app.delete(
				`${basePath}/:id`,
				({ params }) => {
					const result = tableHelper.delete(params.id);
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
