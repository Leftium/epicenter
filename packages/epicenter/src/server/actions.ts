import { Elysia } from 'elysia';
import type { Actions } from '../core/actions';
import { iterateActions } from '../core/actions';

type ActionsRouterOptions = {
	actions: Actions;
	basePath?: string;
};

export function createActionsRouter(options: ActionsRouterOptions) {
	const { actions, basePath = '/actions' } = options;
	const router = new Elysia({ prefix: basePath });

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
					async ({ query }) => {
						if (action.input) {
							const result = await action.input['~standard'].validate(query);
							if (result.issues) {
								return {
									error: {
										message: 'Validation failed',
										issues: result.issues,
									},
								};
							}
							const output = await action.handler(result.value);
							return { data: output };
						}
						const output = await (action.handler as () => unknown)();
						return { data: output };
					},
					{ query: action.input, detail },
				);
				break;
			case 'mutation':
				router.post(
					routePath,
					async ({ body }) => {
						if (action.input) {
							const result = await action.input['~standard'].validate(body);
							if (result.issues) {
								return {
									error: {
										message: 'Validation failed',
										issues: result.issues,
									},
								};
							}
							const output = await action.handler(result.value);
							return { data: output };
						}
						const output = await (action.handler as () => unknown)();
						return { data: output };
					},
					{ body: action.input, detail },
				);
				break;
			default: {
				const _exhaustive: never = action;
				throw new Error(`Unknown action type: ${_exhaustive}`);
			}
		}
	}

	return router;
}

export function collectActionPaths(actions: Actions): string[] {
	return [...iterateActions(actions)].map(([, path]) => path.join('/'));
}
