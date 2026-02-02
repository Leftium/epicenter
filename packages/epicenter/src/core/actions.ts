/**
 * Action System: Lightweight boundary layer for exposing workspace functionality.
 *
 * Actions are plain objects with handlers and metadata for cross-boundary invocation.
 * They enable REST API endpoints, MCP tool definitions, CLI commands, and OpenAPI docs.
 *
 * @example
 * ```typescript
 * import { defineQuery, defineMutation } from '@epicenter/hq';
 *
 * const actions = {
 *   posts: {
 *     getAll: defineQuery({
 *       handler: () => client.tables.get('posts').getAllValid(),
 *     }),
 *     create: defineMutation({
 *       input: type({ title: 'string' }),
 *       handler: ({ title }) => {
 *         client.tables.get('posts').upsert({ id: generateId(), title });
 *         return { id };
 *       },
 *     }),
 *   },
 * };
 *
 * const server = createServer(client, { actions });
 * ```
 */

import type {
	StandardSchemaV1,
	StandardSchemaWithJSONSchema,
} from './schema/standard/types';

type ActionConfig<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = {
	description?: string;
	input?: TInput;
	output?: StandardSchemaWithJSONSchema;
	handler: TInput extends StandardSchemaWithJSONSchema
		? (
				input: StandardSchemaV1.InferOutput<TInput>,
			) => TOutput | Promise<TOutput>
		: () => TOutput | Promise<TOutput>;
};

export type Query<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = ActionConfig<TInput, TOutput> & {
	type: 'query';
};

export type Mutation<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = ActionConfig<TInput, TOutput> & {
	type: 'mutation';
};

export type Action<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
> = Query<TInput, TOutput> | Mutation<TInput, TOutput>;

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
 *   handler: () => client.tables.get('posts').getAllValid(),
 * });
 *
 * const getPost = defineQuery({
 *   input: type({ id: 'string' }),
 *   handler: ({ id }) => client.tables.get('posts').get({ id }),
 * });
 * ```
 */
export function defineQuery<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
>(config: ActionConfig<TInput, TOutput>): Query<TInput, TOutput> {
	return { type: 'query', ...config } as Query<TInput, TOutput>;
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
 *   handler: ({ title }) => {
 *     client.tables.get('posts').upsert({ id: generateId(), title });
 *     return { id };
 *   },
 * });
 *
 * const syncMarkdown = defineMutation({
 *   description: 'Sync markdown files to YJS',
 *   handler: () => client.extensions.markdown.pullFromMarkdown(),
 * });
 * ```
 */
export function defineMutation<
	TInput extends StandardSchemaWithJSONSchema | undefined = undefined,
	TOutput = unknown,
>(config: ActionConfig<TInput, TOutput>): Mutation<TInput, TOutput> {
	return { type: 'mutation', ...config } as Mutation<TInput, TOutput>;
}

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

export function isQuery(value: unknown): value is Query<any, any> {
	return isAction(value) && value.type === 'query';
}

export function isMutation(value: unknown): value is Mutation<any, any> {
	return isAction(value) && value.type === 'mutation';
}

export function* iterateActions(
	actions: Actions,
	path: string[] = [],
): Generator<[Action<any, any>, string[]]> {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAction(value)) {
			yield [value, currentPath];
		} else {
			yield* iterateActions(value, currentPath);
		}
	}
}
