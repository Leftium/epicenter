import type {
	AnyWorkspaceClient,
	BaseRow,
	TableHelper,
} from '@epicenter/workspace';
import { Elysia } from 'elysia';

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
 * Create an Elysia plugin that exposes tables as REST CRUD endpoints.
 *
 * Uses parameterized routes so Eden Treaty can infer the full type chain.
 * The caller mounts this under `/:workspaceId` prefix.
 */
export function createTablesPlugin(
	workspaces: Record<string, AnyWorkspaceClient>,
) {
	return new Elysia({ prefix: '/:workspaceId/tables' })
		.get(
			'/:tableName',
			({ params, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					params.tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				return tableHelper.getAllValid();
			},
			{
				detail: { description: 'List all rows in a table', tags: ['tables'] },
			},
		)
		.get(
			'/:tableName/:id',
			({ params, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					params.tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				const result = tableHelper.get(params.id);
				if (result.status === 'not_found') return status('Not Found', result);
				if (result.status === 'invalid')
					return status('Unprocessable Content', result);
				return result;
			},
			{
				detail: { description: 'Get row by ID', tags: ['tables'] },
			},
		)
		.put(
			'/:tableName/:id',
			({ params, body, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					params.tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				const result = tableHelper.parse(params.id, body);
				if (result.status === 'invalid')
					return status('Unprocessable Content', result);
				tableHelper.set(result.row);
				return result;
			},
			{
				detail: {
					description: 'Create or replace row by ID',
					tags: ['tables'],
				},
			},
		)
		.patch(
			'/:tableName/:id',
			({ params, body, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					params.tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				const result = tableHelper.update(
					params.id,
					body as Record<string, unknown>,
				);
				if (result.status === 'not_found') return status('Not Found', result);
				if (result.status === 'invalid')
					return status('Unprocessable Content', result);
				return result;
			},
			{
				detail: {
					description: 'Partial update row by ID',
					tags: ['tables'],
				},
			},
		)
		.delete(
			'/:tableName/:id',
			({ params, status }) => {
				const tableHelper = resolveTable(
					workspaces,
					params.workspaceId,
					params.tableName,
				);
				if (!tableHelper)
					return status('Not Found', { error: 'Table not found' });
				return tableHelper.delete(params.id);
			},
			{
				detail: { description: 'Delete row by ID', tags: ['tables'] },
			},
		);
}
