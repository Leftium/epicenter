import { Elysia } from 'elysia';
import { Ok } from 'wellcrafted/result';
import type { AnyWorkspaceClient, TableHelper } from '../static/types';

export function createTablesPlugin(
	workspaceClients: Record<string, AnyWorkspaceClient>,
) {
	const app = new Elysia();

	for (const [workspaceId, workspace] of Object.entries(workspaceClients)) {
		const tableDefinitions = workspace.definitions.tables;

		for (const [tableName, value] of Object.entries(workspace.tables)) {
			const tableDef = tableDefinitions[tableName];
			if (!tableDef) continue;

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
				({ body, status }) => {
					const input = body as Record<string, unknown>;
					const result = tableDef.schema['~standard'].validate(input);
					if (result instanceof Promise) {
						return status(500, {
							error: 'Async schema validation not supported',
						});
					}
					if (result.issues) {
						return status(422, { errors: result.issues });
					}

					const row = tableDef.migrate(result.value) as {
						id: string;
					};
					tableHelper.set(row);
					return Ok({ id: row.id });
				},
				{
					detail: { description: `Create or update ${tableName}`, tags },
				},
			);

			app.put(
				`${basePath}/:id`,
				({ params, body }) => {
					const partial = body as Record<string, unknown>;
					const result = tableHelper.update(params.id, partial);
					return Ok(result);
				},
				{
					detail: { description: `Update ${tableName} by ID`, tags },
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
