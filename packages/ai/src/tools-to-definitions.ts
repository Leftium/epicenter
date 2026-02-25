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

import type { AnyClientTool, JSONSchema } from '@tanstack/ai';

/** JSON Schema with `properties` and `required` guaranteed present. */
type NormalizedJSONSchema = JSONSchema &
	Required<Pick<JSONSchema, 'properties' | 'required'>>;

export type ServerToolDefinition = {
	name: string;
	description: string;
	inputSchema?: NormalizedJSONSchema;
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
			inputSchema: normalizeSchema(tool.inputSchema as JSONSchema),
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
function normalizeSchema(schema: JSONSchema): NormalizedJSONSchema {
	return {
		...schema,
		properties: schema.properties ?? {},
		required: schema.required ?? [],
	};
}
