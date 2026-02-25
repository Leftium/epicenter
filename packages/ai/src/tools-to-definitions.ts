/**
 * Strip client tools down to plain definitions for the server request body.
 *
 * Takes `AnyClientTool[]` (the output of {@link actionsToClientTools}) and
 * removes runtime-only fields (`execute`, `__toolSide`, `needsApproval`),
 * leaving only what the AI provider needs: `name`, `description`, and
 * `inputSchema` (normalized for provider compatibility).
 *
 * @module
 */

import type { AnyClientTool } from '@tanstack/ai';

export type ServerToolDefinition = {
	name: string;
	description: string;
	inputSchema?: unknown;
};

/**
 * Strip client tools to plain definitions for the server request body.
 *
 * The server forwards these to the AI provider so the model knows which
 * tools it can call. The actual `execute` functions stay on the client.
 *
 * @example
 * ```ts
 * const tools = actionsToClientTools(workspace.actions);
 *
 * new ChatClient({ tools, connection: fetchServerSentEvents(url, async () => ({
 *   body: { tools: toDefinitions(tools) },
 * })) });
 * ```
 */
export function toDefinitions(
	tools: readonly AnyClientTool[],
): ServerToolDefinition[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		...(tool.inputSchema && {
			inputSchema: normalizeSchema(tool.inputSchema),
		}),
	}));
}

/**
 * Normalize a JSON Schema for AI provider compatibility.
 *
 * Some providers (notably Anthropic) reject schemas with missing `properties`
 * or `required` fields. TypeBox omits `required` when no fields are required,
 * and `Type.Object({})` already includes `properties: {}`, but we ensure both
 * are always present.
 */
function normalizeSchema(schema: unknown): unknown {
	if (typeof schema !== 'object' || schema === null) return schema;
	const s = schema as Record<string, unknown>;
	return {
		...s,
		properties: (s.properties as Record<string, unknown>) ?? {},
		required: (s.required as string[]) ?? [],
	};
}
