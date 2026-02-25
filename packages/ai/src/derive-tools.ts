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
import { iterateActions } from '@epicenter/hq';
import type { JSONSchema, ServerTool, ToolDefinition } from '@tanstack/ai';
import { toolDefinition } from '@tanstack/ai';
import type { TSchema } from 'typebox';

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
	/** The original TypeBox input schema from the action, if any. */
	inputSchema?: TSchema;
};

export type ServerToolDefinition = {
	name: string;
	description: string;
	inputSchema?: TSchema;
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
	 * Uses the original TypeBox schemas directly (already JSON Schema).
	 */
	serverDefinitions: ServerToolDefinition[];

	/** All derived tools with metadata — the source of truth the above are projected from. */
	entries: DerivedTool[];
};

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
	action: Action,
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
		...(action.input ? { inputSchema: action.input } : {}),
		...(needsApproval && { needsApproval: true }),
		metadata: { actionType: action.type, actionPath: path },
	});

	return {
		definition: def,
		path,
		isMutation,
		...(action.input && { inputSchema: action.input }),
	};
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
		...(e.inputSchema && { inputSchema: e.inputSchema }),
	}));

	return { definitions, tools, serverDefinitions, entries };
}
