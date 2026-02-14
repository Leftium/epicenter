/**
 * Workspace introspection — produces a portable, JSON-serializable descriptor
 * of a workspace's tables, KV stores, awareness fields, and actions.
 *
 * Generic tools (editors, MCP clients, data browsers, plugin systems) can
 * consume this descriptor to discover and interact with arbitrary workspaces
 * they have no compile-time knowledge of.
 *
 * @example
 * ```typescript
 * import { describeWorkspace } from 'epicenter/static';
 *
 * const descriptor = describeWorkspace(client);
 * console.log(JSON.stringify(descriptor, null, 2));
 * // {
 * //   id: "epicenter.whispering",
 * //   tables: { recordings: { schema: { type: "object", ... } } },
 * //   kv: { settings: { schema: { ... } } },
 * //   awareness: {},
 * //   actions: [
 * //     { path: ["recordings", "create"], type: "mutation", description: "..." },
 * //   ]
 * // }
 * ```
 */

import type { JsonSchema } from 'arktype';
import { iterateActions } from '../shared/actions.js';
import { standardSchemaToJsonSchema } from '../shared/standard-schema/to-json-schema.js';
import type { StandardJSONSchemaV1 } from '../shared/standard-schema/types.js';
import type { AnyWorkspaceClient } from './types.js';

// ════════════════════════════════════════════════════════════════════════════
// DESCRIPTOR TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Descriptor for a single table — name is the key in the parent record. */
export type TableDescriptor = {
	schema: JsonSchema;
};

/** Descriptor for a single KV store — name is the key in the parent record. */
export type KvDescriptor = {
	schema: JsonSchema;
};

/** Descriptor for a single awareness field — name is the key in the parent record. */
export type AwarenessDescriptor = {
	schema: JsonSchema;
};

/** Descriptor for a single action (query or mutation). */
export type ActionDescriptor = {
	path: string[];
	type: 'query' | 'mutation';
	description?: string;
	input?: JsonSchema;
};

/**
 * A portable, JSON-serializable descriptor of a workspace.
 *
 * Every schema field is guaranteed to be a `JsonSchema` (never undefined) —
 * the `StandardSchemaWithJSONSchema` type constraint on definitions ensures this.
 * Action inputs are optional since some actions have no input.
 */
export type WorkspaceDescriptor = {
	id: string;
	tables: Record<string, TableDescriptor>;
	kv: Record<string, KvDescriptor>;
	awareness: Record<string, AwarenessDescriptor>;
	actions: ActionDescriptor[];
};

// ════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Produce a portable, JSON-serializable descriptor of a workspace.
 *
 * Walks `definitions.tables`, `definitions.kv`, `definitions.awareness`,
 * and `client.actions` to extract JSON Schema representations of all data shapes.
 *
 * @param client - Any workspace client (typed or untyped)
 * @returns A `WorkspaceDescriptor` that can be safely `JSON.stringify`'d
 *
 * @example
 * ```typescript
 * const descriptor = describeWorkspace(client);
 *
 * // List all table names
 * Object.keys(descriptor.tables); // ['recordings', 'transformations']
 *
 * // Get the JSON Schema for a table
 * descriptor.tables.recordings.schema; // { type: 'object', properties: { ... } }
 *
 * // Iterate actions
 * for (const action of descriptor.actions) {
 *   console.log(action.path.join('.'), action.type);
 * }
 * ```
 */
export function describeWorkspace(
	client: AnyWorkspaceClient,
): WorkspaceDescriptor {
	const tables: Record<string, TableDescriptor> = {};
	for (const [name, def] of Object.entries(client.definitions.tables) as [
		string,
		{ schema: StandardJSONSchemaV1 },
	][]) {
		tables[name] = {
			schema: standardSchemaToJsonSchema(def.schema),
		};
	}

	const kv: Record<string, KvDescriptor> = {};
	for (const [name, def] of Object.entries(client.definitions.kv) as [
		string,
		{ schema: StandardJSONSchemaV1 },
	][]) {
		kv[name] = {
			schema: standardSchemaToJsonSchema(def.schema),
		};
	}

	const awareness: Record<string, AwarenessDescriptor> = {};
	for (const [name, schema] of Object.entries(client.definitions.awareness) as [
		string,
		StandardJSONSchemaV1,
	][]) {
		awareness[name] = {
			schema: standardSchemaToJsonSchema(schema),
		};
	}

	const actions: ActionDescriptor[] = [];
	if (client.actions) {
		for (const [action, path] of iterateActions(client.actions)) {
			const descriptor: ActionDescriptor = {
				path,
				type: action.type,
			};
			if (action.description !== undefined) {
				descriptor.description = action.description;
			}
			if (action.input !== undefined) {
				descriptor.input = standardSchemaToJsonSchema(action.input);
			}
			actions.push(descriptor);
		}
	}

	return {
		id: client.id,
		tables,
		kv,
		awareness,
		actions,
	};
}
