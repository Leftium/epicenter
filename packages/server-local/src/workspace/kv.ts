import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Elysia } from 'elysia';

/**
 * Create an Elysia plugin that exposes KV store as REST endpoints.
 *
 * Uses parameterized routes so Eden Treaty can infer the full type chain.
 * The caller mounts this under `/:workspaceId` prefix.
 */
export function createKvPlugin(workspaces: Record<string, AnyWorkspaceClient>) {
	return new Elysia({ prefix: '/:workspaceId/kv' })
		.get(
			'/:key',
			({ params, status }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace)
					return status('Not Found', { error: 'Workspace not found' });
				try {
					const result = workspace.kv.get(params.key);
					if (result.status === 'not_found') return status('Not Found', result);
					if (result.status === 'invalid')
						return status('Unprocessable Content', result);
					return result;
				} catch (error) {
					return status('Bad Request', {
						error: error instanceof Error ? error.message : 'Unknown KV key',
					});
				}
			},
			{
				detail: { description: 'Get KV value by key', tags: ['kv'] },
			},
		)
		.put(
			'/:key',
			({ params, body, status }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace)
					return status('Not Found', { error: 'Workspace not found' });
				try {
					workspace.kv.set(params.key, body as never);
					return { status: 'set' as const, key: params.key };
				} catch (error) {
					return status('Bad Request', {
						error: error instanceof Error ? error.message : 'Unknown KV key',
					});
				}
			},
			{
				detail: { description: 'Set KV value by key', tags: ['kv'] },
			},
		)
		.delete(
			'/:key',
			({ params, status }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace)
					return status('Not Found', { error: 'Workspace not found' });
				try {
					workspace.kv.delete(params.key);
					return { status: 'deleted' as const, key: params.key };
				} catch (error) {
					return status('Bad Request', {
						error: error instanceof Error ? error.message : 'Unknown KV key',
					});
				}
			},
			{
				detail: { description: 'Delete KV entry by key', tags: ['kv'] },
			},
		);
}
