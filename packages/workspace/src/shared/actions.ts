/**
 * Action System v2: Closure-based handlers for Epicenter.
 *
 * This module provides the core action definition system for Epicenter.
 * Actions are typed operations (queries for reads, mutations for writes) that
 * capture their dependencies via closures at definition time.
 *
 * ## Design Pattern: Closure-Based Dependency Injection
 *
 * Actions close over their dependencies directly instead of receiving context as a parameter:
 * - Define actions **after** creating the client
 * - Handlers reference the client via closure: signature is `(input?) => output`
 * - Adapters (Server, CLI) receive both client and actions separately: `{ client, actions }`
 *
 * **Key benefits:**
 * - **Zero annotation ceremony**: TypeScript infers handler types naturally
 * - **Type-safe**: Full type inference for client and tables, not `unknown`
 * - **Simpler signatures**: `(input?) => output` instead of `(ctx, input?) => output`
 * - **Natural JavaScript**: Uses standard closures, no framework magic
 * - **Introspectable**: Callable functions with metadata properties for adapters
 *
 * ## Transport Widens the Error Surface
 *
 * An action's return type depends on where it's called from. **Local** callers
 * see the handler's signature verbatim — sync stays sync, raw stays raw, throws
 * throw. **Remote** callers (over `attachSync` RPC) always see
 * `Promise<Result<TOutput, TError | ActionError>>`: the transport wraps raw
 * values in `Ok`, converts thrown errors into `Err(ActionError)`, and passes
 * existing `Result`s through. This means a mutation declared as
 * `(input) => Result<T, FooError>` becomes `Promise<Result<T, FooError | ActionError>>`
 * once it crosses the wire — the error union widens by `ActionError`, and the
 * return becomes a `Promise`. This is intentional: handlers stay ergonomic
 * locally (write plain JS, throw when it makes sense), while remote callers get
 * a uniform `Result` envelope they can pattern-match on. When writing a handler
 * that will be exposed remotely, assume any thrown error will reach remote
 * callers as `ActionError` — if you need structured errors on the wire, return
 * `Err(...)` explicitly.
 *
 * ## Exports
 *
 * - {@link defineQuery} - Define a read operation
 * - {@link defineMutation} - Define a write operation
 * - {@link isAction}, {@link isQuery}, {@link isMutation} - Type guards for action definitions
 * - {@link iterateActions} - Traverse and introspect action definition trees
 *
 * @example
 * ```typescript
 * import * as Y from 'yjs';
 * import {
 *   createDocumentFactory,
 *   attachTable,
 *   defineQuery,
 *   defineMutation,
 * } from '@epicenter/workspace';
 * import Type from 'typebox';
 *
 * // Step 1: Compose the document inline — actions close over `tables`
 * const blog = createDocumentFactory((id: string) => {
 *   const ydoc = new Y.Doc({ guid: id });
 *   const tables = { posts: attachTable(ydoc, 'posts', postsTable) };
 *
 *   const actions = {
 *     posts: {
 *       getAll: defineQuery({
 *         handler: () => tables.posts.getAllValid(),
 *       }),
 *       create: defineMutation({
 *         input: Type.Object({ title: Type.String() }),
 *         handler: ({ title }) => {
 *           const id = generateId();
 *           tables.posts.set({ id, title, _v: 1 });
 *           return { id };
 *         },
 *       }),
 *     },
 *   };
 *
 *   return { id, ydoc, tables, actions, [Symbol.dispose]() { ydoc.destroy(); } };
 * });
 *
 * const workspace = blog.open('blog');
 *
 * // Step 2: Pass the bundle to adapters
 * createActionsRouter({ client: workspace, actions: workspace.actions });
 * createCLI({ client: workspace, actions: workspace.actions });
 * ```
 *
 * @module
 */

import type { RpcError } from '@epicenter/sync';
import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { isResult } from 'wellcrafted/result';

export { isResult };

/**
 * Global symbol brand used to reliably detect actions across package boundaries.
 *
 * `Symbol.for()` returns the same reference regardless of which copy of
 * `@epicenter/workspace` stamps or checks it—critical for monorepo setups
 * where multiple copies of the package may coexist.
 */
export const ACTION_BRAND: unique symbol = Symbol.for('epicenter.action');

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The handler function type, conditional on whether input is provided.
 *
 * Uses variadic tuple args instead of conditional function signatures so that
 * when the type flows through `Action` (via the `Actions` constraint),
 * `any` distributes over both branches giving `[input: any] | []` — which
 * correctly allows calling with 0 arguments for no-input actions.
 *
 * When `TInput` extends `TSchema`, the handler takes validated input.
 * When `TInput` is `undefined`, the handler takes no arguments.
 */
type ActionHandler<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = (
	...args: TInput extends TSchema ? [input: Static<TInput>] : []
) => TOutput;

/**
 * Configuration for defining an action (query or mutation).
 *
 * @typeParam TInput - The input schema type (TypeBox TSchema), or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @property description - Human-readable description for introspection and documentation
 * @property input - Optional TypeBox schema for validating and typing input
 * @property handler - The action implementation. Handlers close over their dependencies and have signature `(input?) => output`
 *
 * @remarks
 * **Closure-based design**: Handlers capture their dependencies (tables, kv, encryption, etc.)
 * via closure instead of receiving context as a parameter. This means:
 * - Handlers are defined inside the `createDocumentFactory` builder, after the attachments they use
 * - Dependencies are accessed through closure, not as a parameter
 * - No type annotations needed—TypeScript infers everything naturally
 *
 * This is standard JavaScript closure mechanics, not framework magic.
 *
 * @example
 * ```typescript
 * // Inside a createDocumentFactory builder:
 * //   const tables = { posts: attachTable(ydoc, 'posts', postsTable) };
 *
 * // Action with input - closes over tables
 * const config: ActionConfig<typeof inputSchema, Post> = {
 *   input: type({ id: 'string' }),
 *   handler: ({ id }) => tables.posts.get(id),  // tables captured by closure
 * };
 *
 * // Action without input
 * const configNoInput: ActionConfig<undefined, Post[]> = {
 *   handler: () => tables.posts.getAllValid(),  // tables captured by closure
 * };
 * ```
 */
type ActionConfig<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = {
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
	handler: ActionHandler<TInput, TOutput>;
};

/**
 * Metadata properties attached to a callable action.
 *
 * These are the introspection properties available on the action function itself
 * (via `Object.assign`). The handler is NOT included — the action function IS
 * the handler. Call the action directly instead of accessing `.handler`.
 */
type ActionMeta<TInput extends TSchema | undefined = TSchema | undefined> = {
	[ACTION_BRAND]: true;
	type: 'query' | 'mutation';
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
};

/**
 * A query action definition (read operation).
 *
 * Queries are callable functions with metadata properties attached.
 * They are idempotent operations that read data without side effects.
 * When exposed via the server adapter, queries map to HTTP GET requests.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @example
 * ```typescript
 * const getAll = defineQuery({ handler: () => client.tables.posts.getAllValid() });
 * const posts = getAll();      // call directly
 * getAll.type;                  // 'query'
 * getAll.input;                 // schema or undefined
 * ```
 *
 * @see {@link defineQuery} for creating query definitions
 */
export type Query<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = ActionHandler<TInput, TOutput> & ActionMeta<TInput> & { type: 'query' };

/**
 * A mutation action definition (write operation).
 *
 * Mutations are callable functions with metadata properties attached.
 * They are operations that modify state or have side effects.
 * When exposed via the server adapter, mutations map to HTTP POST requests.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 *
 * @example
 * ```typescript
 * const createPost = defineMutation({
 *   input: type({ title: 'string' }),
 *   handler: ({ title }) => { client.tables.posts.upsert({ id: generateId(), title }); },
 * });
 * createPost({ title: 'Hello' }); // call directly
 * createPost.type;                 // 'mutation'
 * ```
 *
 * @see {@link defineMutation} for creating mutation definitions
 */
export type Mutation<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = ActionHandler<TInput, TOutput> & ActionMeta<TInput> & { type: 'mutation' };

/**
 * Union type of Query and Mutation action definitions.
 *
 * Use this when you need to handle any action regardless of type.
 *
 * @typeParam TInput - The input schema type, or undefined for no input
 * @typeParam TOutput - The return type of the handler
 */
export type Action<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
> = Query<TInput, TOutput> | Mutation<TInput, TOutput>;

/**
 * A tree of action definitions, supporting arbitrary nesting.
 *
 * Actions can be organized into namespaces for better organization.
 * Each handler closes over the client and dependencies from its enclosing scope.
 *
 * @example
 * ```typescript
 * // Inside a createDocumentFactory builder, after `const tables = attachTables(ydoc, defs);`
 *
 * const actions: Actions = {
 *   posts: {
 *     getAll: defineQuery({
 *       handler: () => tables.posts.getAllValid()  // closes over tables
 *     }),
 *     create: defineMutation({
 *       handler: ({ title }) => {
 *         const id = generateId();
 *         tables.posts.set({ id, title, _v: 1 });
 *         return { id };
 *       }
 *     }),
 *   },
 *   users: {
 *     profile: {
 *       get: defineQuery({
 *         handler: () => tables.users.getCurrentProfile()  // closes over tables
 *       }),
 *     },
 *   },
 * };
 * ```
 */
export type Actions = {
	[key: string]: Action | Actions;
};

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns a callable function with metadata properties (`type`, `input`, `description`).
 * The `type: 'query'` discriminator is attached automatically.
 * Queries map to HTTP GET requests when exposed via the server adapter.
 *
 * The returned action IS the function — call it directly. There is no `.handler` property.
 * Pass `handler` in the config; it gets promoted to the callable root.
 *
 * @example
 * ```typescript
 * const getAllPosts = defineQuery({
 *   handler: () => client.tables.posts.getAllValid(),
 * });
 * getAllPosts();       // call directly
 * getAllPosts.type;    // 'query'
 *
 * const getPost = defineQuery({
 *   input: type({ id: 'string' }),
 *   handler: ({ id }) => client.tables.posts.get(id),
 * });
 * getPost({ id: '1' }); // call directly with typed input
 * ```
 */
/** No input — `TInput` is explicitly `undefined`. */
export function defineQuery<TOutput = unknown>(
	config: ActionConfig<undefined, TOutput>,
): Query<undefined, TOutput>;
/** With input — `TInput` inferred from the schema. */
export function defineQuery<TInput extends TSchema, TOutput = unknown>(
	config: ActionConfig<TInput, TOutput>,
): Query<TInput, TOutput>;
export function defineQuery({ handler, ...rest }: ActionConfig): Query {
	return Object.assign(handler, {
		[ACTION_BRAND]: true as const,
		type: 'query' as const,
		...rest,
	}) as unknown as Query;
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * The `type: 'mutation'` discriminator is attached automatically.
 * Mutations map to HTTP POST requests when exposed via the server adapter.
 *
 * Handlers close over their dependencies (tables, kv, attachments, etc.) instead
 * of receiving context as a parameter. Define mutations inside the `createDocumentFactory`
 * builder, after the attachments they depend on.
 *
 * @example
 * ```typescript
 * // Inside a createDocumentFactory builder:
 * //   const tables = attachTables(ydoc, defs);
 * //   const recordingsFs = attachRecordingMarkdownFiles(ydoc, tables.recordings, {...});
 *
 * // Mutation that creates a post - closes over tables
 * const createPost = defineMutation({
 *   input: type({ title: 'string' }),
 *   handler: ({ title }) => {
 *     const id = generateId();
 *     tables.posts.set({ id, title, _v: 1 });
 *     return { id };
 *   },
 * });
 *
 * // Mutation that triggers a side-effecting attachment
 * const syncMarkdown = defineMutation({
 *   description: 'Sync markdown files to YJS',
 *   handler: () => recordingsFs.pullFromMarkdown(),
 * });
 * ```
 */
/** No input — `TInput` is explicitly `undefined`. */
export function defineMutation<TOutput = unknown>(
	config: ActionConfig<undefined, TOutput>,
): Mutation<undefined, TOutput>;
/** With input — `TInput` inferred from the schema. */
export function defineMutation<TInput extends TSchema, TOutput = unknown>(
	config: ActionConfig<TInput, TOutput>,
): Mutation<TInput, TOutput>;
export function defineMutation({ handler, ...rest }: ActionConfig): Mutation {
	return Object.assign(handler, {
		[ACTION_BRAND]: true as const,
		type: 'mutation' as const,
		...rest,
	}) as unknown as Mutation;
}

/**
 * Type guard to check if a value is an action definition.
 *
 * Actions are callable functions with a `type` property of 'query' or 'mutation'.
 * Call the action directly — there is no `.handler` property.
 *
 * @param value - The value to check
 * @returns True if the value is an Action definition
 *
 * @example
 * ```typescript
 * if (isAction(value)) {
 *   console.log(value.type); // 'query' | 'mutation'
 *   value(input);            // call directly
 * }
 * ```
 */
export function isAction(value: unknown): value is Action {
	return typeof value === 'function' && ACTION_BRAND in value;
}

/**
 * Type guard to check if a value is a query action definition.
 *
 * @param value - The value to check
 * @returns True if the value is a Query definition
 */
export function isQuery(value: unknown): value is Query {
	return isAction(value) && value.type === 'query';
}

/**
 * Type guard to check if a value is a mutation action definition.
 *
 * @param value - The value to check
 * @returns True if the value is a Mutation definition
 */
export function isMutation(value: unknown): value is Mutation {
	return isAction(value) && value.type === 'mutation';
}

/**
 * Iterate over action definitions, yielding each action with its path.
 *
 * Use this for adapters (CLI, Server) that need to introspect and invoke actions.
 * Each action is callable directly — just call `action(input)`.
 *
 * @param actions - The action tree to iterate over
 * @param path - Internal parameter for tracking the current path (default: [])
 * @yields Tuples of [action, path] where path is an array of keys
 *
 * @example
 * ```typescript
 * // In a server adapter
 * for (const [action, path] of iterateActions(actions)) {
 *   const route = path.join('/');
 *   registerRoute(route, async (input) => action(input));
 * }
 *
 * // In a CLI adapter
 * for (const [action, path] of iterateActions(actions)) {
 *   const command = path.join(':');
 *   cli.command(command, async (input) => action(input));
 * }
 * ```
 */
export function* iterateActions(
	actions: object,
	path: string[] = [],
): Generator<[Action, string[]]> {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAction(value)) {
			yield [value, currentPath];
		} else if (value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Promise)) {
			yield* iterateActions(value, currentPath);
		}
	}
}

/**
 * Resolve a dotted action path against an action tree and invoke it with
 * `input`. Used to adapt workspace actions into the generic
 * `{ dispatch(action, input) }` surface that sync RPC expects.
 *
 * Throws if the path doesn't resolve to a branded action.
 */
export async function dispatchAction(
	actions: Actions,
	path: string,
	input: unknown,
): Promise<unknown> {
	const segments = path.split('.');
	let target: unknown = actions;
	for (const segment of segments) {
		if (target == null || typeof target !== 'object') {
			throw new Error(`Action not found: ${path}`);
		}
		target = (target as Record<string, unknown>)[segment];
	}
	if (!isAction(target)) {
		throw new Error(`Action not found: ${path}`);
	}
	return await target(input as never);
}

// ════════════════════════════════════════════════════════════════════════════
// ACTION FAILED (transport envelope)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Transport-layer error for actions invoked over RPC.
 *
 * Exists to solve a wire problem: thrown errors don't cross processes. Local
 * callers never see this — they `try/catch` instead. It appears only in
 * `RemoteAction` signatures and in the RPC boundary's normalization path.
 *
 * Sourced from `@epicenter/sync`'s `RpcError` so the wire and the remote-action
 * type surface share a single nominal `ActionFailed` — no re-wrapping between
 * layers, one `name` discriminant to match on.
 */
export type ActionFailed = Extract<RpcError, { name: 'ActionFailed' }>;

// ════════════════════════════════════════════════════════════════════════════
// REMOTE ACTION TYPES (RPC proxy surface)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Unwrap Promise if present; then wrap in `Result<_, ActionFailed>`,
 * merging with any existing Result error channel.
 */
export type RemoteReturn<TOutput> = TOutput extends Promise<infer Inner>
	? RemoteReturn<Inner>
	: TOutput extends Result<infer T, infer E>
		? Promise<Result<T, E | ActionFailed>>
		: Promise<Result<TOutput, ActionFailed>>;

export type RemoteAction<A extends Action> = A extends Action<
	infer TInput,
	infer TOutput
>
	? (
			...args: TInput extends TSchema ? [input: Static<TInput>] : []
		) => RemoteReturn<TOutput>
	: never;

// Order matters: Action must be checked before Actions, because functions
// with properties structurally satisfy Actions' index signature.
export type RemoteActions<A extends Actions> = {
	[K in keyof A]: A[K] extends Action
		? RemoteAction<A[K]>
		: A[K] extends Actions
			? RemoteActions<A[K]>
			: never;
};
