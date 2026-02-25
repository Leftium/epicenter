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
import type { StandardJSONSchemaV1 } from '@standard-schema/spec';
import type { JSONSchema, ServerTool, ToolDefinition } from '@tanstack/ai';
import { toolDefinition } from '@tanstack/ai';

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

/** Shorthand — the three generics are always the same for derived tools. */
type ToolDef = ToolDefinition<JSONSchema, JSONSchema, string>;

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

	/** Return false to exclude an action from the tool set. */
	filter?: (info: { type: 'query' | 'mutation'; path: string[] }) => boolean;
};

export type DerivedTool = {
	definition: ToolDef;
	path: string[];
	isMutation: boolean;
};

export type ServerToolDefinition = {
	name: string;
	description: string;
	inputSchema?: JSONSchema;
};

export type DeriveToolsResult = {
	/**
	 * Raw definitions with `.server(execute)` and `.client(execute)` methods.
	 * Use when you need to bind custom implementations.
	 */
	definitions: ToolDef[];

	/**
	 * Pre-bound server tools — action handlers wired as execute functions.
	 * Pass directly to `chat({ tools: result.tools })`.
	 */
	tools: ServerTool<JSONSchema, JSONSchema, string>[];

	/**
	 * JSON-serializable definitions for request bodies.
	 * Schemas are pre-converted to plain JSON Schema (ArkType-safe).
	 */
	serverDefinitions: ServerToolDefinition[];

	/** All derived tools with metadata — the source of truth the above are projected from. */
	entries: DerivedTool[];
};

// ════════════════════════════════════════════════════════════════════════════
// Schema normalization
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convert a Standard Schema (e.g. ArkType) to a plain JSON Schema object
 * normalized for LLM provider consumption.
 *
 * - Strips `$schema` (providers don't expect it)
 * - Ensures `properties` and `required` exist (ArkType omits them for
 *   empty or all-optional schemas, but providers expect them)
 */
function toNormalizedJsonSchema(schema: StandardJSONSchemaV1): JSONSchema {
	const raw = standardSchemaToJsonSchema(schema as any) as Record<
		string,
		unknown
	>;
	const { $schema: _, ...rest } = raw;
	return {
		type: 'object',
		...rest,
		properties: (rest.properties as Record<string, unknown>) ?? {},
		required: (rest.required as string[]) ?? [],
	} as JSONSchema;
}

// ════════════════════════════════════════════════════════════════════════════
// Single action → ToolDefinition
// ════════════════════════════════════════════════════════════════════════════

/**
 * Convert a single action + path into a TanStack AI ToolDefinition.
 *
 * Passes the action's input schema directly through to `toolDefinition()`.
 * TanStack AI's `convertSchemaToJsonSchema` handles Standard Schema
 * conversion internally.
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

	const needsApproval = isMutation && requireApprovalForMutations;

	const def = toolDefinition({
		name,
		description,
		...(action.input && { inputSchema: action.input }),
		...(needsApproval && { needsApproval: true }),
		metadata: { actionType: action.type, actionPath: path },
	});

	return { definition: def, path, isMutation };
}

// ════════════════════════════════════════════════════════════════════════════
// Action tree → Tools
// ════════════════════════════════════════════════════════════════════════════

/**
 * Derive TanStack AI tools from a workspace action tree.
 *
 * @example
 * ```typescript
 * const { tools, definitions, serverDefinitions } = deriveTools(client.actions);
 *
 * // Server-side: pass pre-bound tools to chat()
 * chat({ tools, model: 'claude-sonnet-4-20250514', messages });
 *
 * // Client-side: bind custom execute fns
 * const clientTools = definitions.map((d) => d.client(...));
 *
 * // SSE request bodies: use pre-converted JSON Schema
 * fetch('/api/chat', { body: JSON.stringify({ tools: serverDefinitions }) });
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

		tools.push(
			derived.definition.server(async (args: unknown) =>
				action.input ? action(args) : action(),
			),
		);
	}

	// Projections from entries — definitions for binding, serverDefinitions for wire format
	const definitions = entries.map((e) => e.definition);

	const serverDefinitions = entries.map<ServerToolDefinition>((e) => ({
		name: e.definition.name,
		description: e.definition.description,
		...(e.definition.inputSchema && {
			inputSchema: toNormalizedJsonSchema(e.definition.inputSchema),
		}),
	}));

	return { definitions, tools, serverDefinitions, entries };
}
