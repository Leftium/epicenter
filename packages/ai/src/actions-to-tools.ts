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
	/** If true, mutations will require user approval before executing. @default false */
	requireApprovalForMutations?: boolean;
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
	{
		nameSeparator = '/',
		requireApprovalForMutations = false,
	}: ActionsToToolsOptions = {},
): Tool[] {
	return [...iterateActions(actions)].map(([action, path]) => ({
		name: path.join(nameSeparator),
		description: action.description ?? `${action.type}: ${path.join('.')}`,
		...(action.input && { inputSchema: action.input }),
		...(requireApprovalForMutations &&
			action.type === 'mutation' && { needsApproval: true }),
		execute: async (args: unknown) => (action.input ? action(args) : action()),
	}));
}
