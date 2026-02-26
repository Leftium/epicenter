/**
 * Convert workspace actions into TanStack AI client tools.
 *
 * This is the single source of truth for turning actions into tools.
 * Client tools are the highest-fidelity representation — they include
 * `execute` handlers and `__toolSide: 'client'` for `ChatClient`.
 *
 * To get plain definitions for the server request body, pass the result
 * through {@link toDefinitions} which strips runtime-only fields:
 *
 * ```
 *   actionsToClientTools(actions)       toDefinitions(tools)
 *   ┌──────────────────────────┐       ┌────────────────────┐
 *   │ __toolSide: 'client'     │       │                    │
 *   │ name                     │  ──►  │ name               │
 *   │ description              │       │ description        │
 *   │ inputSchema? (raw)       │       │ inputSchema? (norm)│
 *   │ execute ✓                │       │                    │
 *   │ needsApproval?           │       └────────────────────┘
 *   └──────────────────────────┘        ServerToolDefinition
 *          AnyClientTool
 * ```
 *
 * @module
 */

import type { Actions } from '@epicenter/hq';
import { iterateActions } from '@epicenter/hq';
import type { AnyClientTool } from '@tanstack/ai';
import { ACTION_NAME_SEPARATOR, type ActionNames } from './action-names';

type ActionsToClientToolsOptions = {
	/** If true, mutations will require user approval before executing. @default false */
	requireApprovalForMutations?: boolean;
};

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
	{ requireApprovalForMutations = false }: ActionsToClientToolsOptions = {},
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
