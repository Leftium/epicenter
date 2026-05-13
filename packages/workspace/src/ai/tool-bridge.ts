/**
 * Bridge between workspace actions and TanStack AI's tool system.
 *
 * TanStack AI needs tools in two places:
 *
 * 1. **In the browser**: `createChat({ tools })` expects an array of
 *    `AnyClientTool` objects with `execute` functions so the `ChatClient`
 *    can run tool calls locally without a server round-trip.
 *
 * 2. **On the server**: the HTTP request body needs a JSON-serializable
 *    description of each tool (name, description, input schema) so the
 *    server can forward them to the AI provider. Functions like `execute`
 *    can't travel over the wire.
 *
 * This module converts a flat workspace action registry (keys authored as
 * dot paths) into both representations at once, so you don't have to build
 * them by hand. The AI tool name is the action key with `.` swapped for
 * `_` (provider name regex requires `[a-zA-Z0-9_-]+`).
 *
 * @module
 */

import type { AnyClientTool, JSONSchema } from '@tanstack/ai';
import type { Action, ActionRegistry } from '../shared/actions';
import { invokeAction } from '../shared/actions';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Type-level `'.'` -> `'_'` swap on every dot in a string literal. Mirrors
 * the runtime `path.replaceAll('.', '_')` at the AI boundary.
 */
type DotsToUnderscores<S extends string> = S extends `${infer A}.${infer B}`
	? `${A}_${DotsToUnderscores<B>}`
	: S;

/**
 * Tool names produced from an action registry: action key with `.` replaced
 * by `_`.
 *
 * **Constraint**: Action keys must not contain underscores, or flattened
 * names will collide (e.g. action key `"foo_bar"` vs path `foo.bar` both
 * produce `"foo_bar"`).
 *
 * @example
 * ```ts
 * type Names = ActionNames<typeof workspace.actions>;
 * // "tabs_search" | "tabs_list" | ...
 * ```
 */
export type ActionNames<TActions> = {
	[K in keyof TActions & string]: TActions[K] extends Action
		? DotsToUnderscores<K>
		: never;
}[keyof TActions & string];

/**
 * JSON-serializable description of a tool, sent to the server in the HTTP
 * request body. This is what the AI provider sees. It tells the LLM what
 * tools exist, what arguments they accept, and whether they need user
 * approval before running.
 *
 * This is the "wire" counterpart to TanStack AI's `AnyClientTool`. The
 * client tool has an `execute` function (not JSON-serializable); this type
 * has everything EXCEPT `execute`, so it can travel in a `fetch()` body.
 *
 * Includes `title` when the action declares one, so UI components can show
 * human-readable labels (e.g. "Close Tabs" instead of "tabs_close")
 * without needing a separate lookup.
 *
 * @see {@link actionsToAiTools} for how actions are converted into these.
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
 * Convert a workspace action registry into the two representations TanStack AI
 * needs for AI-powered chat with tool calling.
 *
 * ### What you get
 *
 * - **`.tools`**: Pass these to `createChat({ tools })`. They're TanStack AI
 *   `AnyClientTool` objects with `execute` wired to your action handlers.
 *   When the LLM calls a tool, `ChatClient` runs the matching `execute`
 *   function in the browser automatically, no server round-trip needed.
 *
 * - **`.definitions`**: Send these to the server in your HTTP request body.
 *   They're the same tools minus `execute` (which can't be serialized to
 *   JSON), plus normalized input schemas. The server forwards them to the AI
 *   provider so the LLM knows what tools are available. Each definition also
 *   includes `title` when the action declares one, so UI components can show
 *   human-readable labels directly.
 *
 * ### How it works
 *
 * The action registry is a flat record keyed by dot path. This function
 * renames each key by swapping `.` for `_` so the result is a flat tool
 * list whose names match the AI provider's `[a-zA-Z0-9_-]+` requirement:
 *
 * ```
 * { 'tabs.close': defineMutation(...) }  →  tool named "tabs_close"
 * { 'files.read': defineQuery(...) }     →  tool named "files_read"
 * ```
 *
 * Mutations automatically get `needsApproval: true` so the chat UI can show
 * a confirmation dialog before executing them. Queries run immediately.
 *
 * @param actions - The flat action registry to expose as tools.
 *
 * @example
 * ```ts
 * import { actionsToAiTools } from '@epicenter/workspace/ai';
 *
 * export const workspaceAiTools = actionsToAiTools(workspace.actions);
 *
 * // Pass .tools to TanStack AI's ChatClient for local execution
 * const chat = createChat({
 *   tools: workspaceAiTools.tools,
 *   connection: fetchServerSentEvents('/ai/chat', () => ({
 *     body: {
 *       data: {
 *         // Pass .definitions to the server so the LLM knows what tools exist
 *         tools: workspaceAiTools.definitions,
 *       },
 *     },
 *   })),
 * });
 *
 * // Show a friendly title in the UI when a tool call comes back
 * const title = workspaceAiTools.definitions
 *   .find(d => d.name === 'tabs_close')?.title; // → 'Close Tabs'
 * ```
 */
export function actionsToAiTools<TActions extends ActionRegistry>(
	actions: TActions,
): {
	tools: (AnyClientTool & { name: ActionNames<TActions> })[];
	definitions: ToolDefinition[];
} {
	const entries = Object.entries(actions).map(([path, action]) => {
		if (path.includes(ACTION_NAME_SEPARATOR)) {
			throw new Error(
				`Action keys used as AI tools cannot contain "${ACTION_NAME_SEPARATOR}" at "${path}"`,
			);
		}
		return [path, action] as const;
	});

	const tools = entries.map(([path, action]) => {
		const name = path.replaceAll('.', ACTION_NAME_SEPARATOR);
		return {
			__toolSide: 'client' as const,
			name: name as ActionNames<TActions>,
			description: action.description ?? `${action.type}: ${name}`,
			...(action.input && { inputSchema: action.input }),
			...(action.type === 'mutation' && { needsApproval: true }),
			// TanStack AI's `execute` contract is: return data on success, throw
			// on failure. invokeAction handles all four handler shapes (raw,
			// Result, sync, async) and converts thrown errors into typed
			// Err(ActionFailed); we then unwrap for AI consumption.
			execute: async (args: unknown) => {
				const result = await invokeAction(action, args, name);
				if (result.error !== null) throw result.error;
				return result.data;
			},
		};
	});

	// Derive wire definitions directly from actions. Avoids the type-widening
	// round-trip through AnyClientTool that required `as JSONSchema` casts.
	const definitions: ToolDefinition[] = entries.map(([path, action]) => {
		const name = path.replaceAll('.', ACTION_NAME_SEPARATOR);
		return {
			name,
			...(action.title && { title: action.title }),
			description: action.description ?? `${action.type}: ${name}`,
			// Safe cast: workspace actions only accept TypeBox schemas (TSchema),
			// which ARE plain JSON Schema objects at runtime.
			...(action.input && {
				inputSchema: normalizeSchema(action.input as JSONSchema),
			}),
			...(action.type === 'mutation' && { needsApproval: true }),
		};
	});

	return { tools, definitions };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Separator used when projecting an action's dot-path key into a tool name.
 *
 * Action keys must not contain this character, or projected names will
 * collide. For example, key `"foo_bar"` and path `foo.bar` would both
 * produce `"foo_bar"`.
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
