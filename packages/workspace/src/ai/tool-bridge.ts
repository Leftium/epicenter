/**
 * Bridge between Epicenter workspace actions and TanStack AI tool types.
 *
 * Converts a workspace `Actions` tree into two representations:
 *
 * - **`tools`** — executable `AnyClientTool[]` for the browser. Passed to
 *   `ChatClientOptions.tools` so the `ChatClient` auto-executes tool calls locally.
 * - **`definitions`** — wire-safe `ToolDefinition[]` for the HTTP request body.
 *   Sent to the server so `chat()` knows what tools exist without needing them
 *   hardcoded. The server passes these directly to `chat({ tools })`.
 *
 * Each definition includes the action's `title` when declared, so consumers
 * can show human-readable labels without re-walking the action tree.
 *
 * This multi-representation design exists because the app does not control the
 * backend server—tools must travel over the wire as JSON in the request body,
 * while the browser needs executable handlers locally.
 *
 * @module
 */

import type { Action, Actions } from '../shared/actions';
import { iterateActions } from '../shared/actions';
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
 * **Constraint**: Action keys must not contain underscores, or flattened names
 * will collide (e.g. action key `"foo_bar"` vs nested path `foo → bar` both
 * produce `"foo_bar"`).
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
 * Wire-safe tool definition sent to the server as part of the HTTP request body.
 *
 * The server receives these and passes them directly to TanStack AI's
 * `chat({ tools })`. Every field the server needs must be included here—anything
 * stripped is lost forever.
 *
 * Compatible with TanStack AI's `Tool` interface minus `execute` (not
 * JSON-serializable) and `__toolSide` (`chat()` uses `execute` presence
 * for routing instead).
 *
 * ### Field rationale
 *
 * - **`name`** — Identity. The LLM and server use this to route tool calls.
 * - **`title`** — Human-readable display name for UI surfaces and MCP annotations.
 *   Optional because not every action declares a title.
 * - **`description`** — The LLM reads this to decide when to call the tool.
 * - **`inputSchema`** — The LLM uses this to generate valid arguments. Normalized
 *   with `properties` and `required` guaranteed present because some providers
 *   (notably Anthropic) reject schemas without them.
 * - **`needsApproval`** — Present on all mutations (policy: mutations always
 *   require user confirmation). Queries omit it entirely.
 *
 * @see {@link actionsToAiTools} for how actions are converted into these definitions.
 */
export type ToolDefinition = {
	name: string;
	title?: string;
	description: string;
	inputSchema?: NormalizedJsonSchema;
	needsApproval?: boolean;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a workspace action tree into AI tool representations.
 *
 * Returns an object with two properties derived from the same action tree:
 *
 * - **`tools`** — Executable `AnyClientTool[]` with `execute` wired to action
 *   handlers. Pass to `ChatClientOptions.tools` for local auto-execution.
 * - **`definitions`** — Wire-safe `ToolDefinition[]` with schemas normalized
 *   for provider compatibility and `title` included when the action declares one.
 *   Send to the server as JSON in the request body.
 *
 * ```
 * workspace.actions (nested tree)
 *       │
 *       ▼  actionsToAiTools()
 * ┌─────────────────────────────────────────────────────────────┐
 * │                                                             │
 * │  .tools        AnyClientTool[] (browser, has execute)    │
 * │  .definitions  ToolDefinition[] (wire-safe JSON + title)  │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 * ```
 *
 * Tool names are path segments joined with `_` (e.g. `tabs_search`, `files_read`).
 * Mutations get `needsApproval: true`; queries omit it. Input schemas are
 * normalized for Anthropic compatibility (`properties` and `required` guaranteed).
 *
 * @example
 * ```ts
 * import { actionsToAiTools } from '@epicenter/workspace/ai';
 *
 * export const workspaceAiTools = actionsToAiTools(workspace.actions);
 *
 * // ChatClient — local execution
 * createChat({ tools: workspaceAiTools.tools });
 *
 * // HTTP body — wire payload
 * fetch('/chat', { body: JSON.stringify({ tools: workspaceAiTools.definitions }) });
 *
 * // UI — display title for a tool call
 * workspaceAiTools.definitions.find(d => d.name === 'tabs_close')?.title // → 'Close Tabs'
 * ```
 */
export function actionsToAiTools<TActions extends Actions>(
	actions: TActions,
): {
	tools: (AnyClientTool & { name: ActionNames<TActions> })[];
	definitions: ToolDefinition[];
} {
	const entries = [...iterateActions(actions)];

	const tools = entries.map(([action, path]) => ({
		__toolSide: 'client' as const,
		name: path.join(ACTION_NAME_SEPARATOR) as ActionNames<TActions>,
		description: action.description ?? `${action.type}: ${path.join(ACTION_NAME_SEPARATOR)}`,
		...(action.input && { inputSchema: action.input }),
		...(action.type === 'mutation' && { needsApproval: true }),
		execute: async (args: unknown) => (action.input ? action(args) : action()),
	}));

	// Derive wire definitions directly from actions—avoids the type-widening
	// round-trip through AnyClientTool that required `as JSONSchema` casts.
	const definitions: ToolDefinition[] = entries.map(
		([action, path]) => ({
			name: path.join(ACTION_NAME_SEPARATOR),
			...(action.title && { title: action.title }),
			description: action.description ?? `${action.type}: ${path.join(ACTION_NAME_SEPARATOR)}`,
			// Safe cast: workspace actions only accept TypeBox schemas (TSchema),
			// which ARE plain JSON Schema objects at runtime.
			...(action.input && {
				inputSchema: normalizeSchema(action.input as JSONSchema),
			}),
			...(action.type === 'mutation' && { needsApproval: true }),
		}),
	);

	return { tools, definitions };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Separator used to join action path segments into tool names.
 *
 * Action keys must not contain this character, or flattened names will collide.
 * For example, key `"foo_bar"` and nested path `foo → bar` would both produce
 * `"foo_bar"`.
 */
const ACTION_NAME_SEPARATOR = '_';

/** JSON Schema with `properties` and `required` guaranteed present. */
type NormalizedJsonSchema = JSONSchema &
	Required<Pick<JSONSchema, 'properties' | 'required'>>;

/**
 * Normalize a JSON Schema for AI provider compatibility.
 *
 * Some providers (notably Anthropic) reject schemas with missing `properties`
 * or `required` fields. This ensures both are always present.
 */
function normalizeSchema(schema: JSONSchema): NormalizedJsonSchema {
	return {
		...schema,
		properties: schema.properties ?? {},
		required: schema.required ?? [],
	};
}
