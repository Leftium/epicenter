/**
 * Action System v2: Context-passing handlers with attachment pattern.
 *
 * This module provides the core action definition and attachment system for Epicenter.
 * Actions are typed operations (queries for reads, mutations for writes) that receive
 * the workspace client context as their first parameter.
 *
 * ## Design Pattern
 *
 * Actions follow a two-phase lifecycle:
 * 1. **Definition**: Actions are defined with `defineQuery` or `defineMutation`, specifying
 *    a handler function with signature `(ctx, input?) => output`
 * 2. **Attachment**: Actions are attached to a client via `.withActions()`, which captures
 *    the context and returns callable functions with signature `(input?) => output`
 *
 * This separation enables:
 * - Type-safe handler definitions with full inference
 * - Metadata introspection for adapters (CLI, Server, etc.)
 * - Testability by allowing different contexts to be provided
 *
 * ## Exports
 *
 * - {@link defineQuery} - Define a read operation
 * - {@link defineMutation} - Define a write operation
 * - {@link attachActions} - Attach actions to a context
 * - {@link isAction}, {@link isQuery}, {@link isMutation} - Type guards for action definitions
 * - {@link isAttachedAction} - Type guard for attached actions
 * - {@link iterateActions}, {@link iterateAttachedActions} - Traverse action trees
 *
 * @example
 * ```typescript
 * import { createWorkspaceClient, defineQuery, defineMutation } from '@epicenter/hq';
 * import { type } from 'arktype';
 *
 * export default createWorkspaceClient({ ... })
 *   .withActions({
 *     posts: {
 *       getAll: defineQuery({
 *         handler: (ctx) => ctx.tables.posts.getAllValid(),
 *       }),
 *       create: defineMutation({
 *         input: type({ title: 'string' }),
 *         handler: (ctx, { title }) => {
 *           ctx.tables.posts.upsert({ id: generateId(), title });
 *           return { id };
 *         },
 *       }),
 *     },
 *   });
 * ```
 *
 * @module
 */

import type {
	StandardSchemaV1,
	StandardSchemaWithJSONSchema,
} from '../shared/standard-schema/types';

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Configuration for defining an action (query or mutation).
 *
 * @typeParam TInput - The input schema type (StandardSchema), or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @property description - Human-readable description for introspection and documentation
 * @property input - Optional StandardSchema for validating and typing input
 * @property output - Optional StandardSchema for output (used by adapters for serialization)
 * @property handler - The action implementation with signature `(ctx, input?) => output`
 *
 * @remarks
 * The handler receives the workspace client as `ctx`. This parameter is captured
 * when actions are attached via `.withActions()`, so callers only provide `input`.
 *
 * @example
 * ```typescript
 * // Action with input
 * const config: ActionConfig<typeof inputSchema, Post> = {
 *   input: type({ id: 'string' }),
 *   handler: (ctx, { id }) => ctx.tables.posts.get(id),
 * };
 *
 * // Action without input
 * const configNoInput: ActionConfig<undefined, Post[]> = {
 *   handler: (ctx) => ctx.tables.posts.getAllValid(),
 * };
 * ```
 */
type ActionConfig<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = {
	description?: string;
	input?: TInput;
	output?: StandardSchemaWithJSONSchema;
	handler: TInput extends StandardSchemaWithJSONSchema
		? (
				ctx: unknown,
				input: StandardSchemaV1.InferOutput<TInput>,
			) => TOutput | Promise<TOutput>
		: (ctx: unknown) => TOutput | Promise<TOutput>;
};

/**
 * A query action definition (read operation).
 *
 * Queries are idempotent operations that read data without side effects.
 * When exposed via the server adapter, queries map to HTTP GET requests.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @see {@link defineQuery} for creating query definitions
 */
export type Query<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = ActionConfig<TInput, TOutput> & {
	type: 'query';
};

/**
 * A mutation action definition (write operation).
 *
 * Mutations are operations that modify state or have side effects.
 * When exposed via the server adapter, mutations map to HTTP POST requests.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @see {@link defineMutation} for creating mutation definitions
 */
export type Mutation<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = ActionConfig<TInput, TOutput> & {
	type: 'mutation';
};

/**
 * Union type of Query and Mutation action definitions.
 *
 * Use this when you need to handle any action regardless of type.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 */
export type Action<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = Query<TInput, TOutput> | Mutation<TInput, TOutput>;

/**
 * A tree of action definitions, supporting arbitrary nesting.
 *
 * Actions can be organized into namespaces for better organization:
 *
 * @example
 * ```typescript
 * const actions: Actions = {
 *   posts: {
 *     getAll: defineQuery({ handler: (ctx) => ... }),
 *     create: defineMutation({ handler: (ctx, input) => ... }),
 *   },
 *   users: {
 *     profile: {
 *       get: defineQuery({ handler: (ctx) => ... }),
 *     },
 *   },
 * };
 * ```
 */
export type Actions = {
	[key: string]: Action<any, any> | Actions;
};

/**
 * Define a query (read operation) with full type inference.
 *
 * The `type: 'query'` discriminator is attached automatically.
 * Queries map to HTTP GET requests when exposed via the server adapter.
 *
 * @example
 * ```typescript
 * const getAllPosts = defineQuery({
 *   handler: (ctx) => ctx.tables.posts.getAllValid(),
 * });
 *
 * const getPost = defineQuery({
 *   input: type({ id: 'string' }),
 *   handler: (ctx, { id }) => ctx.tables.posts.get(id),
 * });
 * ```
 */
export function defineQuery<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
>(config: ActionConfig<TInput, TOutput>): Query<TInput, TOutput> {
	return { type: 'query' as const, ...config };
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * The `type: 'mutation'` discriminator is attached automatically.
 * Mutations map to HTTP POST requests when exposed via the server adapter.
 *
 * @example
 * ```typescript
 * const createPost = defineMutation({
 *   input: type({ title: 'string' }),
 *   handler: (ctx, { title }) => {
 *     ctx.tables.posts.upsert({ id: generateId(), title });
 *     return { id };
 *   },
 * });
 *
 * const syncMarkdown = defineMutation({
 *   description: 'Sync markdown files to YJS',
 *   handler: (ctx) => ctx.extensions.markdown.pullFromMarkdown(),
 * });
 * ```
 */
export function defineMutation<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
>(config: ActionConfig<TInput, TOutput>): Mutation<TInput, TOutput> {
	return { type: 'mutation' as const, ...config };
}

/**
 * Type guard to check if a value is an action definition.
 *
 * Returns true if the value is an object with:
 * - A `type` property of 'query' or 'mutation'
 * - A `handler` function
 *
 * @param value - The value to check
 * @returns True if the value is an Action definition
 *
 * @example
 * ```typescript
 * if (isAction(value)) {
 *   // value is typed as Action<any, any>
 *   console.log(value.type); // 'query' | 'mutation'
 *   value.handler(ctx, input);
 * }
 * ```
 */
export function isAction(value: unknown): value is Action<any, any> {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		(value.type === 'query' || value.type === 'mutation') &&
		'handler' in value &&
		typeof value.handler === 'function'
	);
}

/**
 * Type guard to check if a value is a query action definition.
 *
 * @param value - The value to check
 * @returns True if the value is a Query definition
 */
export function isQuery(value: unknown): value is Query<any, any> {
	return isAction(value) && value.type === 'query';
}

/**
 * Type guard to check if a value is a mutation action definition.
 *
 * @param value - The value to check
 * @returns True if the value is a Mutation definition
 */
export function isMutation(value: unknown): value is Mutation<any, any> {
	return isAction(value) && value.type === 'mutation';
}

/**
 * Iterate over all actions in a tree, yielding each action with its path.
 *
 * Works with both action definitions and attached actions. Useful for
 * introspection, registration, or transformation of action trees.
 *
 * @param actions - The action tree to iterate over
 * @param path - Internal parameter for tracking the current path (default: [])
 * @yields Tuples of [action, path] where path is an array of keys
 *
 * @example
 * ```typescript
 * const actions = {
 *   posts: {
 *     getAll: defineQuery({ handler: (ctx) => ... }),
 *     create: defineMutation({ handler: (ctx, input) => ... }),
 *   },
 * };
 *
 * for (const [action, path] of iterateActions(actions)) {
 *   console.log(path.join('.')); // 'posts.getAll', 'posts.create'
 *   console.log(action.type);    // 'query', 'mutation'
 * }
 * ```
 */
export function* iterateActions(
	actions: Actions | AttachedActions,
	path: string[] = [],
): Generator<[Action<any, any> | AttachedAction<any, any>, string[]]> {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAction(value) || isAttachedAction(value)) {
			yield [value, currentPath];
		} else {
			yield* iterateActions(value as Actions | AttachedActions, currentPath);
		}
	}
}

/**
 * Iterate over attached actions only, yielding each action with its path.
 *
 * Unlike {@link iterateActions}, this only yields attached actions (callable
 * functions with context pre-filled). Use this for adapters (CLI, Server)
 * that need to invoke actions directly.
 *
 * @param actions - The attached action tree to iterate over
 * @param path - Internal parameter for tracking the current path (default: [])
 * @yields Tuples of [attachedAction, path] where path is an array of keys
 *
 * @example
 * ```typescript
 * // In a CLI adapter
 * for (const [action, path] of iterateAttachedActions(client.actions)) {
 *   registerCommand(path.join('.'), async (input) => {
 *     return await action(input);
 *   });
 * }
 * ```
 */
export function* iterateAttachedActions(
	actions: AttachedActions,
	path: string[] = [],
): Generator<[AttachedAction<any, any>, string[]]> {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAttachedAction(value)) {
			yield [value, currentPath];
		} else {
			yield* iterateAttachedActions(value as AttachedActions, currentPath);
		}
	}
}

// ════════════════════════════════════════════════════════════════════════════
// ATTACHED ACTION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * An action that has been attached to a workspace client.
 *
 * Attached actions are callable functions that execute the handler with the
 * client context pre-filled. They also expose metadata (type, description,
 * input/output schemas) for introspection by adapters.
 *
 * @remarks
 * We use "attached" rather than "bound" terminology because:
 * - "Attach" describes the relationship: actions are attached TO a client
 * - "Bound" has JavaScript baggage (Function.prototype.bind) that's technically
 *   accurate but less intuitive for the mental model we want
 * - Effect-TS uses "provide", Express uses "attach" - we follow the simpler term
 * - Matches our existing `.withExtensions()` pattern semantically
 *
 * @example
 * ```typescript
 * // After attachment, actions are callable with just the input
 * client.actions.posts.create({ title: 'Hello' });
 *
 * // Metadata is still accessible for introspection
 * client.actions.posts.create.type; // 'mutation'
 * client.actions.posts.create.input; // StandardSchema
 * ```
 */
export type AttachedAction<TInput = unknown, TOutput = unknown> = {
	type: 'query' | 'mutation';
	description?: string;
	input?: StandardSchemaWithJSONSchema;
	output?: StandardSchemaWithJSONSchema;
} & (TInput extends undefined
	? () => TOutput | Promise<TOutput>
	: (input: TInput) => TOutput | Promise<TOutput>);

/**
 * A tree of attached actions, mirroring the original action tree structure.
 *
 * This is the return type of {@link attachActions} and the type of
 * `client.actions` after calling `.withActions()`.
 *
 * @example
 * ```typescript
 * // Attached actions are callable with just the input
 * const attached: AttachedActions = attachActions(actions, client);
 * attached.posts.create({ title: 'Hello' });
 *
 * // Metadata is preserved for introspection
 * attached.posts.create.type; // 'mutation'
 * attached.posts.create.description; // 'Create a new post'
 * ```
 */
export type AttachedActions = {
	[key: string]: AttachedAction<any, any> | AttachedActions;
};

/**
 * Type guard for attached actions.
 *
 * Attached actions are callable functions with action metadata properties.
 */
export function isAttachedAction(
	value: unknown,
): value is AttachedAction<any, any> {
	return (
		typeof value === 'function' &&
		'type' in value &&
		(value.type === 'query' || value.type === 'mutation')
	);
}

/**
 * Attaches action handlers to a workspace client context, enabling them to be
 * called with just the input parameter.
 *
 * @remarks
 * This performs partial application: handlers defined as `(ctx, input) => output`
 * become callable as `(input) => output` because `ctx` is captured in a closure.
 * We call this "attaching" rather than "binding" to emphasize the relationship
 * (actions belong to a client) over the mechanism (closure capture).
 *
 * @param actions - The action tree to attach
 * @param ctx - The workspace client context to capture
 * @returns A new action tree where all handlers have ctx pre-filled
 *
 * @example
 * ```typescript
 * const actions = {
 *   posts: {
 *     create: defineMutation({
 *       input: type({ title: 'string' }),
 *       handler: (ctx, { title }) => ctx.tables.posts.upsert({ ... }),
 *     }),
 *   },
 * };
 *
 * const attached = attachActions(actions, client);
 * attached.posts.create({ title: 'Hello' }); // ctx is pre-filled
 * ```
 */
export function attachActions<T extends Actions>(
	actions: T,
	ctx: unknown,
): AttachedActions {
	const attached: AttachedActions = {};

	for (const [key, value] of Object.entries(actions)) {
		if (isAction(value)) {
			// Create a callable function with metadata properties
			const callable = ((input?: unknown) => {
				if (value.input) {
					return value.handler(ctx, input);
				}
				return (value.handler as (ctx: unknown) => unknown)(ctx);
			}) as AttachedAction<any, any>;

			// Copy metadata to the function
			Object.defineProperties(callable, {
				type: { value: value.type, enumerable: true },
				description: { value: value.description, enumerable: true },
				input: { value: value.input, enumerable: true },
				output: { value: value.output, enumerable: true },
			});

			attached[key] = callable;
		} else {
			// Recursively attach nested action groups
			attached[key] = attachActions(value, ctx);
		}
	}

	return attached;
}
