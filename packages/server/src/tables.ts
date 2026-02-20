import type {
	AnyWorkspaceClient,
	BaseRow,
	TableHelper,
} from '@epicenter/hq/static';
import { Elysia } from 'elysia';

export function createTablesPlugin(
	workspaceClients: Record<string, AnyWorkspaceClient>,
) {
	const app = new Elysia();

	for (const [workspaceId, workspace] of Object.entries(workspaceClients)) {
		for (const [tableName, value] of Object.entries(workspace.tables)) {
			const tableHelper = value as TableHelper<BaseRow>;

			const tags = [workspaceId, 'tables'];
			const tableRouter = new Elysia({
				prefix: `/${workspaceId}/tables/${tableName}`,
			});

			tableRouter.get('/', () => tableHelper.getAllValid(), {
				detail: { description: `List all ${tableName}`, tags },
			});

			tableRouter.get(
				'/:id',
				({ params, status }) => {
					const result = tableHelper.get(params.id);
					if (result.status === 'not_found')
						return status('Internal Server Error', result);
					if (result.status === 'invalid')
						return status('Unprocessable Content', result);
					return result;
				},
				{
					detail: { description: `Get ${tableName} by ID`, tags },
				},
			);

			tableRouter.put(
				'/:id',
				({ params, body, status }) => {
					const result = tableHelper.parse(params.id, body);
					if (result.status === 'invalid')
						return status('Unprocessable Content', result);
					tableHelper.set(result.row);
					return result;
				},
				{
					detail: { description: `Create or replace ${tableName} by ID`, tags },
				},
			);

			tableRouter.patch(
				'/:id',
				({ params, body, status }) => {
					const result = tableHelper.update(
						params.id,
						body as Record<string, unknown>,
					);
					if (result.status === 'not_found') return status(404, result);
					if (result.status === 'invalid')
						return status('Unprocessable Content', result);
					return result;
				},
				{
					detail: { description: `Partial update ${tableName} by ID`, tags },
				},
			);

			tableRouter.delete(
				'/:id',
				({ params }) => tableHelper.delete(params.id),
				{
					detail: { description: `Delete ${tableName} by ID`, tags },
				},
			);

			app.use(tableRouter);
		}
	}

	return app;
}
