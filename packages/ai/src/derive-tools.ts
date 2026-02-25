/**
 * Derive TanStack AI tool definitions from workspace action trees.
 *
 * This is the AI adapter counterpart to:
 * - `createActionsRouter` (server adapter → Elysia HTTP routes)
 * - `buildActionCommands` (CLI adapter → yargs commands)
 *
 * @module
 */

import type { Action, Actions } from '@epicenter/hq';
import { iterateActions, standardSchemaToJsonSchema } from '@epicenter/hq';
import type { JSONSchema, ServerTool, ToolDefinition } from '@tanstack/ai';
import { toolDefinition } from '@tanstack/ai';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export type DeriveToolsOptions = {
	/**
	 * When true, mutations get `needsApproval: true` on the tool definition.
	 * @default false
	 */
	requireApprovalForMutations?: boolean;

	/**
	 * Custom separator for joining path segments into tool names.
	 * @default '/'
	 */
	nameSeparator?: string;

	/** Optional filter — return false to exclude an action from the tool set. */
	filter?: (info: { type: 'query' | 'mutation'; path: string[] }) => boolean;
};

export type DerivedTool = {
	definition: ToolDefinition<JSONSchema, JSONSchema, string>;
	path: string[];
	isMutation: boolean;
};

export type DeriveToolsResult = {
	/**
	 * ToolDefinition instances with `.server(execute)` and `.client(execute)` methods.
	 * Use these when you need to bind custom implementations.
	 */
	definitions: ToolDefinition<JSONSchema, JSONSchema, string>[];

	/**
	 * Pre-bound server tools — action handlers wired as execute functions.
	 * Pass directly to `chat({ tools: result.tools })`.
	 */
	tools: ServerTool<JSONSchema, JSONSchema, string>[];

	/**
	 * JSON-serializable tool definitions for request bodies.
	 * Schemas are pre-converted JSON Schema objects.
	 */
	serverDefinitions: Array<{
		name: string;
		description: string;
		inputSchema?: JSONSchema;
	}>;

	/** Individual derived tools with metadata, for advanced use. */
	entries: DerivedTool[];
};

// ════════════════════════════════════════════════════════════════════════════
// Single action → ToolDefinition
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convert a single action + path into a TanStack AI ToolDefinition.
 *
 * Passes the action's input schema directly through to `toolDefinition()`.
 * TanStack AI's `convertSchemaToJsonSchema` handles the Standard Schema
 * protocol internally. If ArkType's `typeof === 'function'` causes issues
 * downstream, the `serverDefinitions` output pre-converts via
 * `standardSchemaToJsonSchema()` as a fallback.
 */
export function actionToToolDefinition(
	action: Action<any, any>,
	path: string[],
	{
		requireApprovalForMutations = false,
		nameSeparator = '/',
	}: DeriveToolsOptions = {},
): DerivedTool {
	const name = path.join(nameSeparator);
	const isMutation = action.type === 'mutation';

	const description =
		action.description ??
		`${isMutation ? 'Mutation' : 'Query'}: ${path.join('.')}`;

	const def = toolDefinition({
		name,
		description,
		...(action.input && { inputSchema: action.input }),
		...(isMutation && requireApprovalForMutations && { needsApproval: true }),
		metadata: {
			actionType: action.type,
			actionPath: path,
		},
	});

	return { definition: def, path, isMutation };
}

// ════════════════════════════════════════════════════════════════════════════
// Action tree → Tools
// ════════════════════════════════════════════════════════════════════════════

/**
 * Derive TanStack AI tools from a workspace action tree.
 *
 * Iterates all actions via `iterateActions()`, converts each to a
 * `ToolDefinition`, and pre-binds server tools with action handlers.
 *
 * @example
 * ```typescript
 * const client = createWorkspace({ ... })
 *   .withActions((c) => ({
 *     posts: {
 *       getAll: defineQuery({ handler: () => c.tables.posts.getAllValid() }),
 *       create: defineMutation({
 *         input: type({ title: 'string' }),
 *         handler: ({ title }) => c.tables.posts.upsert({ ... }),
 *       }),
 *     },
 *   }));
 *
 * const { tools, definitions, serverDefinitions } = deriveTools(client.actions);
 *
 * // Server-side: pass pre-bound tools to chat()
 * chat({ tools, model: 'claude-sonnet-4-20250514', messages });
 *
 * // Client-side: use definitions to bind custom execute fns
 * const clientTools = definitions.map((d) => d.client(...));
 * ```
 */
export function deriveTools(
	actions: Actions,
	options: DeriveToolsOptions = {},
): DeriveToolsResult {
	const entries: DerivedTool[] = [];
	const tools: DeriveToolsResult['tools'] = [];

	for (const [action, path] of iterateActions(actions)) {
		if (options.filter && !options.filter({ type: action.type, path })) {
			continue;
		}

		const derived = actionToToolDefinition(action, path, options);
		entries.push(derived);

		// Pre-bind: wire action handler as server execute function
		tools.push(
			derived.definition.server(async (args: unknown) =>
				action.input ? action(args) : action(),
			),
		);
	}

	const definitions = entries.map((e) => e.definition);

	// serverDefinitions pre-converts to JSON Schema for request bodies,
	// which also serves as the ArkType typeof === 'function' workaround
	// when schemas need to be serialized.
	const serverDefinitions = entries.map((e) => {
		const base = {
			name: e.definition.name,
			description: e.definition.description,
		};
		if (!e.definition.inputSchema) return base;

		const raw = standardSchemaToJsonSchema(
			e.definition.inputSchema as any,
		) as Record<string, unknown>;
		const { $schema: _, ...schema } = raw;
		return {
			...base,
			inputSchema: {
				type: 'object',
				...schema,
				properties: (schema.properties as Record<string, unknown>) ?? {},
				required: (schema.required as string[]) ?? [],
			} as JSONSchema,
		};
	});

	return { definitions, tools, serverDefinitions, entries };
}
