import { type } from 'arktype';
import { Elysia } from 'elysia';
import { Ok } from 'wellcrafted/result';
import { tableToArktype } from '../core/schema';
import type { WorkspaceDoc } from '../dynamic/docs/workspace-doc';

type AnyWorkspaceDoc = WorkspaceDoc<any, any, any>;

export function createTablesPlugin(
	workspaceDocs: Record<string, AnyWorkspaceDoc>,
) {
	const app = new Elysia();

	for (const [workspaceId, workspaceDoc] of Object.entries(workspaceDocs)) {
		for (const tableName of Object.keys(workspaceDoc.tables.definitions)) {
			const tableHelper = workspaceDoc.tables.get(tableName);
			const fields = workspaceDoc.tables.definitions[tableName]!.fields;
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
				({ body }) => {
					tableHelper.upsert(body as { id: string });
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
						id: params.id,
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
