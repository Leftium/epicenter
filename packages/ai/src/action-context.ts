/**
 * Factory that captures an `Actions` generic once and derives everything
 * AI consumers need — tools, definitions, and a label lookup.
 *
 * Assertions live here (infrastructure), never in consumer code.
 *
 * @module
 */

import type { Actions } from '@epicenter/hq';
import type { ActionNames } from './action-names';
import { actionsToClientTools } from './actions-to-client-tools';
import { toDefinitions } from './tools-to-definitions';

/** Display labels for an action's active and completed states. */
export type ActionLabel = { active: string; done: string };

/**
 * Create a typed action context from a workspace action tree.
 *
 * Captures the `TActions` generic at the call site and returns tools,
 * definitions, and a label lookup — all properly typed.
 *
 * @example
 * ```ts
 * const ctx = createActionContext(workspace.actions, {
 *   labels: {
 *     tabs_search: { active: 'Searching', done: 'Searched' },
 *     // ... compile error if you miss one
 *   },
 * });
 *
 * ctx.tools;                    // AnyClientTool[]
 * ctx.definitions;              // ServerToolDefinition[]
 * ctx.getLabel('tabs_search');  // ActionLabel
 * ```
 */
export function createActionContext<TActions extends Actions>(
	actions: TActions,
	options: {
		/** Exhaustive map of action name → label. Compile error if you miss one. */
		labels: Record<ActionNames<TActions>, ActionLabel>;
		/** If true, mutations will require user approval before executing. @default false */
		requireApprovalForMutations?: boolean;
	},
) {
	const { labels, ...toolOptions } = options;
	const tools = actionsToClientTools(actions, toolOptions);
	const definitions = toDefinitions(tools);

	return {
		tools,
		definitions,
		getLabel: (name: ActionNames<TActions>): ActionLabel => labels[name],
	};
}
