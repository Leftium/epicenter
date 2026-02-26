/**
 * Create typed action contexts from workspace action trees.
 *
 * Captures an `Actions` generic once and derives everything AI consumers
 * need — client tools, server definitions, and a label lookup.
 *
 * @module
 */

import type { Action, Actions } from '@epicenter/hq';
import { iterateActions } from '@epicenter/hq';
import type { AnyClientTool, JSONSchema } from '@tanstack/ai';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Display labels for an action's active and completed states. */
export type ActionLabel = { active: string; done: string };

/**
 * Recursively extract all tool names from an `Actions` tree as a string literal union.
 *
 * Leaf `Action` nodes produce their key directly. Nested `Actions` objects
 * produce `"parent_child"` paths joined with `_`.
 *
 * @example
 * ```ts
 * type Names = ActionNames<typeof workspace.actions>;
 * // "tabs_search" | "tabs_list" | "tabs_close" | "windows_list" | ...
 * ```
 */
type ActionNames<T extends Actions> = {
	[K in keyof T & string]: T[K] extends Action
		? K
		: T[K] extends Actions
			? `${K}_${ActionNames<T[K]>}`
			: never;
}[keyof T & string];

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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Separator used to join action path segments into tool names. */
const ACTION_NAME_SEPARATOR = '_';

/**
 * Convert a workspace action tree into client-side AI tools.
 *
 * Each action becomes a `ClientTool` with `__toolSide: 'client'` and its
 * handler wired as the `execute` function.
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
 */
function actionsToClientTools<TActions extends Actions>(
	actions: TActions,
	{ requireApprovalForMutations = false }: { requireApprovalForMutations?: boolean } = {},
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

/** JSON Schema with `properties` and `required` guaranteed present. */
type NormalizedJSONSchema = JSONSchema &
	Required<Pick<JSONSchema, 'properties' | 'required'>>;

type ServerToolDefinition = {
	name: string;
	description: string;
	inputSchema?: NormalizedJSONSchema;
};

/**
 * Strip client tools to plain definitions for the server request body.
 *
 * Removes runtime-only fields (`execute`, `__toolSide`, `needsApproval`),
 * leaving only what the AI provider needs.
 */
function toDefinitions(tools: readonly AnyClientTool[]): ServerToolDefinition[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		// Safe cast: our action system only accepts TypeBox schemas (TSchema),
		// which ARE plain JSON Schema objects. AnyClientTool widens the type to
		// SchemaInput (JSONSchema | StandardJSONSchemaV1), but only TypeBox flows
		// through actionsToClientTools.
		...(tool.inputSchema && {
			inputSchema: normalizeSchema(tool.inputSchema as JSONSchema),
		}),
	}));
}

/**
 * Normalize a JSON Schema for AI provider compatibility.
 *
 * Some providers (notably Anthropic) reject schemas with missing `properties`
 * or `required` fields.
 */
function normalizeSchema(schema: JSONSchema): NormalizedJSONSchema {
	return {
		...schema,
		properties: schema.properties ?? {},
		required: schema.required ?? [],
	};
}
