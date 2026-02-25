/**
 * Convert workspace actions into TanStack AI client tools.
 *
 * Produces `AnyClientTool[]` (with `__toolSide: 'client'`) for use with
 * `ChatClient`. For server-side `chat({ tools })`, use `actionsToTools` instead.
 *
 * @module
 */

import type { Actions } from '@epicenter/hq';
import { iterateActions } from '@epicenter/hq';
import type { AnyClientTool } from '@tanstack/ai';
import { ACTION_NAME_SEPARATOR, type ActionNames } from './action-names';
import type { ActionsToToolsOptions } from './actions-to-tools';

/**
 * Convert a workspace action tree into client-side AI tools.
 *
 * Each action becomes a `ClientTool` with `__toolSide: 'client'` and its
 * handler wired as the `execute` function. Pass the result to `ChatClient`.
 *
 * @example
 * ```ts
 * const tools = actionsToClientTools(workspace.actions);
 * new ChatClient({ tools, connection: ... });
 * ```
 */
export function actionsToClientTools<TActions extends Actions>(
	actions: TActions,
	{ requireApprovalForMutations = false }: ActionsToToolsOptions = {},
): (AnyClientTool & { name: ActionNames<TActions> })[] {
	return [...iterateActions(actions)].map(([action, path]) => ({
		__toolSide: 'client' as const,
		name: path.join(ACTION_NAME_SEPARATOR) as ActionNames<TActions>,
		description: action.description ?? `${action.type}: ${path.join('.')}`,
		...(action.input && { inputSchema: action.input }),
		...(requireApprovalForMutations &&
			action.type === 'mutation' && { needsApproval: true }),
		execute: async (args: unknown) => (action.input ? action(args) : action()),
	}));
}
