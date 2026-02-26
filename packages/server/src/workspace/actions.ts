import type { Action, Actions } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Elysia } from 'elysia';
import Value from 'typebox/value';

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
 * Create an Elysia plugin for action endpoints.
 *
 * Uses parameterized routes with a wildcard for the action path.
 */
export function createActionsPlugin(
	workspaces: Record<string, AnyWorkspaceClient>,
) {
	return new Elysia({ prefix: '/:workspaceId/actions' })
		.get(
			'/*',
			async ({ params, query, status, path }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace?.actions)
					return status('Not Found', { error: 'Workspace or actions not found' });

				// Extract action path from the full URL path
				const actionsPrefix = `/workspaces/${params.workspaceId}/actions/`;
				const actionPath = path.startsWith(actionsPrefix)
					? path.slice(actionsPrefix.length)
					: (params as Record<string, string>)['*'] ?? '';

				const action = resolveAction(workspace.actions, actionPath);
				if (!action) return status('Not Found', { error: `Action not found: ${actionPath}` });
				if (action.type !== 'query')
					return status('Bad Request', {
						error: `Action "${actionPath}" is a mutation, use POST`,
					});

				if (action.input) {
					if (!Value.Check(action.input, query))
						return status('Unprocessable Content', {
							errors: [...Value.Errors(action.input, query)],
						});
					return { data: await action(query) };
				}
				return { data: await action() };
			},
			{
				detail: {
					description: 'Run a query action',
					tags: ['actions'],
				},
			},
		)
		.post(
			'/*',
			async ({ params, body, status, path }) => {
				const workspace = workspaces[params.workspaceId];
				if (!workspace?.actions)
					return status('Not Found', { error: 'Workspace or actions not found' });

				const actionsPrefix = `/workspaces/${params.workspaceId}/actions/`;
				const actionPath = path.startsWith(actionsPrefix)
					? path.slice(actionsPrefix.length)
					: (params as Record<string, string>)['*'] ?? '';

				const action = resolveAction(workspace.actions, actionPath);
				if (!action) return status('Not Found', { error: `Action not found: ${actionPath}` });
				if (action.type !== 'mutation')
					return status('Bad Request', {
						error: `Action "${actionPath}" is a query, use GET`,
					});

				if (action.input) {
					if (!Value.Check(action.input, body))
						return status('Unprocessable Content', {
							errors: [...Value.Errors(action.input, body)],
						});
					return { data: await action(body) };
				}
				return { data: await action() };
			},
			{
				detail: {
					description: 'Run a mutation action',
					tags: ['actions'],
				},
			},
		);
}

/**
 * Create an Elysia router for action definitions (legacy per-workspace).
 *
 * Used internally by createWorkspacePlugin for per-workspace dynamic routing.
 */
export function createActionsRouter(actions: Actions, prefix = '/actions') {
	const router = new Elysia({ prefix });

	for (const [action, path] of iterateActions(actions)) {
		const routePath = `/${path.join('/')}`;
		const namespaceTags = path.length > 1 ? [path[0] as string] : [];
		const tags = [...namespaceTags, action.type];

		const detail = {
			summary: path.join('.'),
			description: action.description,
			tags,
		};

		switch (action.type) {
			case 'query':
				router.get(
					routePath,
					async ({ query, status }) => {
						if (action.input) {
							if (!Value.Check(action.input, query))
								return status('Unprocessable Content', {
									errors: Value.Errors(action.input, query),
								});
							return { data: await action(query) };
						}
						return { data: await action() };
					},
					{ detail },
				);
				break;
			case 'mutation':
				router.post(
					routePath,
					async ({ body, status }) => {
						if (action.input) {
							if (!Value.Check(action.input, body))
								return status('Unprocessable Content', {
									errors: Value.Errors(action.input, body),
								});
							return { data: await action(body) };
						}
						return { data: await action() };
					},
					{ detail },
				);
				break;
			default: {
				const _exhaustive: never = action;
				throw new Error(
					`Unknown action type: ${(_exhaustive as { type: string }).type}`,
				);
			}
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
