import type { Actions } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import { Elysia } from 'elysia';
import Value from 'typebox/value';

/**
 * Create an Elysia router for action definitions.
 *
 * @remarks
 * Actions are closure-based - they capture their dependencies (tables, extensions, etc.)
 * at definition time. The router invokes handlers directly.
 *
 * Action input schemas are TypeBox (JSON Schema). Validation is done via
 * `Value.Check()` instead of Elysia's built-in schema validation.
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
