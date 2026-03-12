/**
 * Bridge between Epicenter workspace actions and TanStack AI tool types.
 *
 * Converts workspace `Action` trees into TanStack AI `ClientTool[]` and
 * stripped `ServerToolDefinition[]` for the HTTP request body.
 *
 * @module
 */

import type { Action, Actions } from '@epicenter/workspace';
import { iterateActions } from '@epicenter/workspace';
import type { AnyClientTool, JSONSchema } from '@tanstack/ai';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------


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
export type ActionNames<T extends Actions> = {
	[K in keyof T & string]: T[K] extends Action
		? K
		: T[K] extends Actions
			? `${K}_${ActionNames<T[K]>}`
			: never;
}[keyof T & string];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a workspace action tree into client-side AI tools.
 *
 * Each action becomes a `ClientTool` with `__toolSide: 'client'` and its
 * handler wired as the `execute` function. Tool names are path segments
 * joined with `_` (e.g. `tabs_search`, `windows_list`).
 *
 * ```
 *   actionsToClientTools(actions)       toServerDefinitions(tools)
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
 * @example
 * ```ts
 * const tools = actionsToClientTools(workspace.actions, {
 *   requireApprovalForMutations: true,
 * });
 * ```
 */
export function actionsToClientTools<TActions extends Actions>(
	actions: TActions,
	options?: { requireApprovalForMutations?: boolean },
): (AnyClientTool & { name: ActionNames<TActions> })[] {
	const requireApprovalForMutations =
		options?.requireApprovalForMutations ?? false;

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

/**
 * Strip client tools to plain definitions for the server request body.
 *
 * Removes runtime-only fields (`execute`, `__toolSide`, `needsApproval`),
 * leaving only what the AI provider needs. Normalizes schemas for providers
 * that require `properties` and `required` (notably Anthropic).
 *
 * @example
 * ```ts
 * const tools = actionsToClientTools(workspace.actions);
 * const definitions = toServerDefinitions(tools);
 * // [{ name: 'tabs_search', description: '...', inputSchema?: { ... } }]
 * ```
 */
export function toServerDefinitions(
	tools: readonly AnyClientTool[],
): ServerToolDefinition[] {
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Separator used to join action path segments into tool names. */
const ACTION_NAME_SEPARATOR = '_';

/** JSON Schema with `properties` and `required` guaranteed present. */
type NormalizedJSONSchema = JSONSchema &
	Required<Pick<JSONSchema, 'properties' | 'required'>>;

type ServerToolDefinition = {
	name: string;
	description: string;
	inputSchema?: NormalizedJSONSchema;
};

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
