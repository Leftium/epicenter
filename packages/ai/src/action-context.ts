/**
 * Factory that captures an `Actions` generic once and derives everything
 * AI consumers need — tools, definitions, and lookup functions.
 *
 * Assertions live here (infrastructure), never in consumer code.
 *
 * @module
 */

import type { Actions } from '@epicenter/hq';
import type { ActionNames } from './action-names';
import {
	actionsToClientTools,
	type ActionsToClientToolsOptions,
} from './actions-to-client-tools';
import { toDefinitions } from './tools-to-definitions';

export type ActionContextOptions<
	TActions extends Actions,
	TLookups extends Record<string, Record<ActionNames<TActions>, unknown>>,
> = ActionsToClientToolsOptions & {
	/** Exhaustive lookup maps keyed by action name. Each becomes a `string → T | undefined` function. */
	lookups?: TLookups;
};

/**
 * Create a typed action context from a workspace action tree.
 *
 * Captures the `TActions` generic at the call site and returns tools,
 * definitions, and any lookup functions — all properly typed.
 *
 * @example
 * ```ts
 * const ctx = createActionContext(workspace.actions, {
 *   lookups: {
 *     getToolLabel: {
 *       tabs_search: { active: 'Searching', done: 'Searched' },
 *       // ... compile error if you miss one
 *     },
 *   },
 * });
 *
 * ctx.tools;                    // AnyClientTool[]
 * ctx.definitions;              // ServerToolDefinition[]
 * ctx.getToolLabel(part.name);  // { active, done } | undefined
 * ```
 */
export function createActionContext<
	TActions extends Actions,
	TLookups extends Record<
		string,
		Record<ActionNames<TActions>, unknown>
	> = Record<string, never>,
>(
	actions: TActions,
	options?: ActionContextOptions<TActions, TLookups>,
) {
	const { lookups, ...toolOptions } = options ?? {};

	const tools = actionsToClientTools(actions, toolOptions);
	const definitions = toDefinitions(tools);

	const lookupFns = {} as {
		[K in keyof TLookups]: (
			name: string,
		) => TLookups[K][ActionNames<TActions>] | undefined;
	};

	if (lookups) {
		for (const [key, map] of Object.entries(lookups)) {
			(lookupFns as Record<string, (name: string) => unknown>)[key] = (
				name: string,
			) => (map as Record<string, unknown>)[name];
		}
	}

	return {
		tools,
		definitions,
		...lookupFns,
	};
}
