import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Hono } from 'hono';
import { WorkspaceApiError } from './errors';

/**
 * Create a Hono router that exposes GET, PUT, and DELETE routes for all workspace KV entries.
 * Registers one route per KV key found across all workspaces.
 * @param workspaces - Map of workspace ID to workspace client.
 * @returns A Hono router with routes under `/:workspaceId/kv`.
 */
export function createKvPlugin(workspaces: Record<string, AnyWorkspaceClient>) {
	const kvKeys = new Set<string>();
	for (const workspace of Object.values(workspaces)) {
		for (const name of Object.keys(workspace.definitions.kv)) {
			kvKeys.add(name);
		}
	}

	const router = new Hono();

	for (const key of kvKeys) {
		router.get(`/:workspaceId/kv/${key}`, (c) => {
			const workspace = workspaces[c.req.param('workspaceId')];
			if (!workspace)
				return c.json(WorkspaceApiError.WorkspaceNotFound().error, 404);
			try {
				const result = workspace.kv.get(key);
				if (result.status === 'not_found') return c.json(result, 404);
				if (result.status === 'invalid') return c.json(result, 422);
				return c.json(result);
			} catch (error) {
				return c.json(WorkspaceApiError.KvOperationFailed({ key, cause: error }).error, 400);
			}
		});

		router.put(`/:workspaceId/kv/${key}`, async (c) => {
			const workspace = workspaces[c.req.param('workspaceId')];
			if (!workspace)
				return c.json(WorkspaceApiError.WorkspaceNotFound().error, 404);
			try {
				const body = await c.req.json();
				workspace.kv.set(key, body as never);
				return c.json({ status: 'set' as const, key });
			} catch (error) {
				return c.json(WorkspaceApiError.KvOperationFailed({ key, cause: error }).error, 400);
			}
		});

		router.delete(`/:workspaceId/kv/${key}`, (c) => {
			const workspace = workspaces[c.req.param('workspaceId')];
			if (!workspace)
				return c.json(WorkspaceApiError.WorkspaceNotFound().error, 404);
			try {
				workspace.kv.delete(key);
				return c.json({ status: 'deleted' as const, key });
			} catch (error) {
				return c.json(WorkspaceApiError.KvOperationFailed({ key, cause: error }).error, 400);
			}
		});
	}

	return router;
}
