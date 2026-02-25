/**
 * Extract plain tool definitions from workspace actions for sending to the server.
 *
 * Returns `{ name, description, inputSchema? }[]` — no execute functions.
 * TypeBox schemas are plain JSON Schema at runtime, so they serialize directly.
 *
 * @module
 */

import type { Actions } from '@epicenter/hq';
import { iterateActions } from '@epicenter/hq';
import { ACTION_NAME_SEPARATOR, type ActionNames } from './action-names';

export type ServerToolDefinition<TName extends string = string> = {
	name: TName;
	description: string;
	inputSchema?: unknown;
};

/**
 * Extract tool definitions from a workspace action tree for the server request body.
 *
 * Strips execute functions — only includes name, description, and inputSchema.
 * The server passes these to the AI provider to describe available tools.
 *
 * @example
 * ```ts
 * const defs = actionsToServerDefinitions(workspace.actions);
 * fetch('/ai/chat', { body: JSON.stringify({ tools: defs }) });
 * ```
 */
export function actionsToServerDefinitions<TActions extends Actions>(
	actions: TActions,
): ServerToolDefinition<ActionNames<TActions>>[] {
	return [...iterateActions(actions)].map(([action, path]) => ({
		name: path.join(ACTION_NAME_SEPARATOR) as ActionNames<TActions>,
		description: action.description ?? `${action.type}: ${path.join('.')}`,
		...(action.input && { inputSchema: normalizeSchema(action.input) }),
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
