import { Elysia } from 'elysia';
import type { AttachedActions } from '../shared/actions';
import { iterateAttachedActions } from '../shared/actions';

type ActionsRouterOptions = {
	actions: AttachedActions;
	basePath?: string;
};

/**
 * Create an Elysia router for attached actions.
 *
 * @remarks
 * Only works with attached actions (from client.actions). Attached actions are
 * callable functions that have the workspace context pre-filled.
 */
export function createActionsRouter(options: ActionsRouterOptions) {
	const { actions, basePath = '/actions' } = options;
	const router = new Elysia({ prefix: basePath });

	for (const [action, path] of iterateAttachedActions(actions)) {
		const routePath = `/${path.join('/')}`;
		const namespaceTags = path.length > 1 ? [path[0] as string] : [];
		const tags = [...namespaceTags, action.type];

		const detail = {
			summary: path.join('.'),
			description: action.description,
			tags,
		};

		// Attached actions are callable directly with input
		const callAction = (input?: unknown) =>
			(action as (input?: unknown) => unknown)(input);

		const handleRequest = async (input: unknown) => {
			let validatedInput: unknown;
			if (action.input) {
				const result = await action.input['~standard'].validate(input);
				if (result.issues) {
					return {
						error: { message: 'Validation failed', issues: result.issues },
					};
				}
				validatedInput = result.value;
			}
			const output = await callAction(validatedInput);
			return { data: output };
		};

		switch (action.type) {
			case 'query':
				router.get(
					routePath,
					({ query }) => handleRequest(query),
					{ query: action.input, detail },
				);
				break;
			case 'mutation':
				router.post(
					routePath,
					({ body }) => handleRequest(body),
					{ body: action.input, detail },
				);
				break;
			default: {
				const _exhaustive: never = action.type as never;
				throw new Error(`Unknown action type: ${_exhaustive}`);
			}
		}
	}

	return router;
}

/**
 * Collect action paths for logging/discovery.
 */
export function collectActionPaths(actions: AttachedActions): string[] {
	return [...iterateAttachedActions(actions)].map(([, path]) => path.join('/'));
}
