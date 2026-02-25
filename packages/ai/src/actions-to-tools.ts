/**
 * Convert workspace actions into TanStack AI tools.
 *
 * TypeBox schemas are plain JSON Schema objects at runtime, so `action.input`
 * passes straight through as `inputSchema` — no conversion needed.
 *
 * @module
 */

import type { Actions } from '@epicenter/hq';
import { iterateActions } from '@epicenter/hq';
import type { Tool } from '@tanstack/ai';

export type ActionsToToolsOptions = {
	/** Custom separator for joining path segments into tool names. @default '/' */
	nameSeparator?: string;
	/** Return false to exclude an action from the tool set. */
	filter?: (info: { type: 'query' | 'mutation'; path: string[] }) => boolean;
};

/**
 * Convert a workspace action tree into TanStack AI tools.
 *
 * Each action becomes a `Tool` with its handler wired as the `execute` function.
 * Pass the result directly to `chat({ tools })`.
 *
 * @example
 * ```ts
 * const tools = actionsToTools(client.actions);
 * chat({ tools, adapter, messages });
 * ```
 */
export function actionsToTools(
	actions: Actions,
	options: ActionsToToolsOptions = {},
): Tool[] {
	const { nameSeparator = '/', filter } = options;
	return [...iterateActions(actions)]
		.filter(([action, path]) => !filter || filter({ type: action.type, path }))
		.map(([action, path]) => ({
			name: path.join(nameSeparator),
			description:
				action.description ?? `${action.type}: ${path.join('.')}`,
			...(action.input && { inputSchema: action.input }),
			execute: async (args: unknown) =>
				action.input ? action(args) : action(),
		}));
}
