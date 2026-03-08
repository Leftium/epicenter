import type { Action, Actions, AnyWorkspaceClient } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import Value from 'typebox/value';
import { WorkspaceApiError } from './errors';

/**
 * Resolve an action from a workspace's actions tree given a path.
 */
function resolveAction(
	actions: Actions,
	actionPath: string,
): Action | undefined {
	const segments = actionPath.split('/');
	let current: unknown = actions;

	for (const segment of segments) {
		if (typeof current !== 'object' || current === null) return undefined;
		if (typeof current === 'function') return undefined;
		current = (current as Record<string, unknown>)[segment];
		if (!current) return undefined;
	}

	if (
		typeof current === 'function' &&
		'type' in current &&
		(current.type === 'query' || current.type === 'mutation')
	) {
		return current as unknown as Action;
	}
	return undefined;
}

/**
 * Create a Hono router for action endpoints.
 *
 * Registers per-action static routes at construction time by iterating over all
 * workspaces. Each route gets its own path.
 * Workspace resolution still happens at request time via :workspaceId param.
 */
export function createActionsPlugin(
	workspaces: Record<string, AnyWorkspaceClient>,
) {
	const router = new Hono();

	// Collect unique action shapes across all workspaces.
	// Since workspaces may define the same action paths, we register
	// routes once and resolve the specific workspace at request time.
	const actionPaths = new Map<string, Set<'query' | 'mutation'>>();

	for (const workspace of Object.values(workspaces)) {
		if (!workspace.actions) continue;
		for (const [action, path] of iterateActions(workspace.actions)) {
			const routePath = path.join('/');
			const types = actionPaths.get(routePath) ?? new Set();
			types.add(action.type);
			actionPaths.set(routePath, types);
		}
	}

	for (const [actionPath, types] of actionPaths) {
		const routePath = `/:workspaceId/actions/${actionPath}`;

		const segments = actionPath.split('/');
		const namespaceTags = segments.length > 1 ? [segments[0] as string] : [];

		if (types.has('query')) {
			router.get(routePath, describeRoute({
				summary: actionPath.replace(/\//g, '.'),
				tags: [...namespaceTags, 'query'],
			}), async (c) => {
				const workspaceId = c.req.param('workspaceId')!;
				const workspace = workspaces[workspaceId];
				if (!workspace?.actions)
					return c.json(WorkspaceApiError.ActionsNotConfigured().error, 404);

				const action = resolveAction(workspace.actions, actionPath);
				if (!action)
					return c.json(WorkspaceApiError.ActionNotFound({ actionPath }).error, 404);

				if (action.type !== 'query')
					return c.json(WorkspaceApiError.ActionWrongMethod({ actionPath, expected: 'POST' }).error, 400);

				if (action.input) {
					const query = c.req.query();
					if (!Value.Check(action.input, query))
						return c.json({ errors: [...Value.Errors(action.input, query)] }, 422);
					return c.json({ data: await action(query) });
				}
				return c.json({ data: await action() });
			});
		}

		if (types.has('mutation')) {
			router.post(routePath, describeRoute({
				summary: actionPath.replace(/\//g, '.'),
				tags: [...namespaceTags, 'mutation'],
			}), async (c) => {
				const workspaceId = c.req.param('workspaceId')!;
				const workspace = workspaces[workspaceId];
				if (!workspace?.actions)
					return c.json(WorkspaceApiError.ActionsNotConfigured().error, 404);

				const action = resolveAction(workspace.actions, actionPath);
				if (!action)
					return c.json(WorkspaceApiError.ActionNotFound({ actionPath }).error, 404);

				if (action.type !== 'mutation')
					return c.json(WorkspaceApiError.ActionWrongMethod({ actionPath, expected: 'GET' }).error, 400);

				if (action.input) {
					const body = await c.req.json();
					if (!Value.Check(action.input, body))
						return c.json({ errors: [...Value.Errors(action.input, body)] }, 422);
					return c.json({ data: await action(body) });
				}
				return c.json({ data: await action() });
			});
		}
	}

	return router;
}

/**
 * Collect action paths for logging/discovery.
 */
export function collectActionPaths(actions: Actions): string[] {
	return [...iterateActions(actions)].map(([, path]) => path.join('/'));
}
