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
 * ## Always async, always Result
 *
 * Every action — local or remote — returns `Promise<Result<T, E>>`. Handlers
 * stay ergonomic: a handler may return a raw value, an explicit `Err(...)`, a
 * `Result`, or a `Promise` of any of the above. The framework normalizes:
 * `Result`-shaped returns pass through, raw values are `Ok`-wrapped, and the
 * result is always awaited so callers see a uniform `Promise<Result>` shape.
 * If you need structured errors, return `Err(...)`; otherwise let raw returns
 * auto-wrap. Throwing is still legal — it propagates up to the caller (locally)
 * or becomes `Err(ActionFailed)` over the wire.
 *
 * ## Exports
 *
 * - {@link defineQuery} - Define a read operation
 * - {@link defineMutation} - Define a write operation
 * - {@link isAction}, {@link isQuery}, {@link isMutation} - Type guards for action definitions
 * - {@link iterateActions} - Traverse and introspect action definition trees
 *
 * @module
 */

import type { RpcError } from '@epicenter/sync';
import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { Ok, isResult } from 'wellcrafted/result';

export { isResult };

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Handler return shape — raw value, `Result`, or a `Promise` of either.
 * The framework normalizes everything to `Promise<Result<TOutput, TError>>`.
 */
type HandlerReturn<TOutput, TError> =
	| TOutput
	| Result<TOutput, TError>
	| Promise<TOutput | Result<TOutput, TError>>;

/**
 * The handler function type, conditional on whether input is provided.
 *
 * Uses variadic tuple args instead of conditional function signatures so that
 * when the type flows through `Action` (via the `Actions` constraint),
 * `any` distributes over both branches giving `[input: any] | []` — which
 * correctly allows calling with 0 arguments for no-input actions.
 */
type ActionHandler<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
	TError = never,
> = (
	...args: TInput extends TSchema ? [input: Static<TInput>] : []
) => HandlerReturn<TOutput, TError>;

/**
 * Configuration for defining an action (query or mutation).
 */
type ActionConfig<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
	TError = never,
> = {
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
	handler: ActionHandler<TInput, TOutput, TError>;
};

/**
 * Metadata properties attached to a callable action.
 */
type ActionMeta<TInput extends TSchema | undefined = TSchema | undefined> = {
	type: 'query' | 'mutation';
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
};

/**
 * The callable signature of a normalized action — always returns
 * `Promise<Result<TOutput, TError>>`, regardless of how the handler was authored.
 */
type ActionCallable<
	TInput extends TSchema | undefined,
	TOutput,
	TError,
> = (
	...args: TInput extends TSchema ? [input: Static<TInput>] : []
) => Promise<Result<TOutput, TError>>;

/**
 * A query action definition (read operation).
 *
 * Queries are callable functions with metadata properties attached.
 * They are idempotent operations that read data without side effects.
 * Always returns `Promise<Result<TOutput, TError>>`.
 */
export type Query<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
	TError = never,
> = ActionCallable<TInput, TOutput, TError> &
	ActionMeta<TInput> & { type: 'query' };

/**
 * A mutation action definition (write operation).
 *
 * Mutations are callable functions with metadata properties attached.
 * Always returns `Promise<Result<TOutput, TError>>`.
 */
export type Mutation<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
	TError = never,
> = ActionCallable<TInput, TOutput, TError> &
	ActionMeta<TInput> & { type: 'mutation' };

/**
 * Union type of Query and Mutation action definitions.
 */
export type Action<
	TInput extends TSchema | undefined = TSchema | undefined,
	TOutput = unknown,
	TError = never,
> = Query<TInput, TOutput, TError> | Mutation<TInput, TOutput, TError>;

/**
 * A tree of action definitions, supporting arbitrary nesting.
 *
 * Uses `any` for the action's input/output/error positions in the constraint
 * so that specific `Query<I, T, E>` / `Mutation<I, T, E>` instances assign
 * cleanly through the variadic-args distribution trick.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Actions = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: Action<any, any, any> | Actions;
};

/**
 * Normalize a handler's return value into a `Result`. Already-Result values
 * pass through; raw values are `Ok`-wrapped.
 */
function normalize<TOutput, TError>(
	value: TOutput | Result<TOutput, TError>,
): Result<TOutput, TError> {
	return isResult(value)
		? (value as Result<TOutput, TError>)
		: Ok(value as TOutput);
}

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns a callable function with metadata properties (`type`, `input`, `description`).
 * The returned action always resolves to `Promise<Result<TOutput, TError>>`.
 */
/** No input — `TInput` is explicitly `undefined`. */
export function defineQuery<TOutput = unknown, TError = never>(
	config: ActionConfig<undefined, TOutput, TError>,
): Query<undefined, TOutput, TError>;
/** With input — `TInput` inferred from the schema. */
export function defineQuery<
	TInput extends TSchema,
	TOutput = unknown,
	TError = never,
>(
	config: ActionConfig<TInput, TOutput, TError>,
): Query<TInput, TOutput, TError>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineQuery({ handler, ...rest }: any): Query {
	const callable = async (...args: unknown[]) =>
		normalize(await (handler as (...a: unknown[]) => unknown)(...args));
	return Object.assign(callable, {
		type: 'query' as const,
		...rest,
	}) as unknown as Query;
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * The returned action always resolves to `Promise<Result<TOutput, TError>>`.
 */
/** No input — `TInput` is explicitly `undefined`. */
export function defineMutation<TOutput = unknown, TError = never>(
	config: ActionConfig<undefined, TOutput, TError>,
): Mutation<undefined, TOutput, TError>;
/** With input — `TInput` inferred from the schema. */
export function defineMutation<
	TInput extends TSchema,
	TOutput = unknown,
	TError = never,
>(
	config: ActionConfig<TInput, TOutput, TError>,
): Mutation<TInput, TOutput, TError>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineMutation({ handler, ...rest }: any): Mutation {
	const callable = async (...args: unknown[]) =>
		normalize(await (handler as (...a: unknown[]) => unknown)(...args));
	return Object.assign(callable, {
		type: 'mutation' as const,
		...rest,
	}) as unknown as Mutation;
}

/**
 * Type guard to check if a value is an action definition.
 *
 * Structural check — anything callable with a `type` of `'query'` or
 * `'mutation'` is an action.
 */
export function isAction(value: unknown): value is Action {
	return (
		typeof value === 'function' &&
		'type' in value &&
		(value.type === 'query' || value.type === 'mutation')
	);
}

/**
 * Type guard to check if a value is a query action definition.
 */
export function isQuery(value: unknown): value is Query {
	return isAction(value) && value.type === 'query';
}

/**
 * Type guard to check if a value is a mutation action definition.
 */
export function isMutation(value: unknown): value is Mutation {
	return isAction(value) && value.type === 'mutation';
}

/**
 * Iterate over action definitions, yielding each action with its path.
 */
export function* iterateActions(
	actions: object,
	path: string[] = [],
): Generator<[Action, string[]]> {
	for (const [key, value] of Object.entries(actions)) {
		const currentPath = [...path, key];
		if (isAction(value)) {
			yield [value, currentPath];
		} else if (
			value != null &&
			typeof value === 'object' &&
			!Array.isArray(value) &&
			!(value instanceof Promise)
		) {
			yield* iterateActions(value, currentPath);
		}
	}
}

/**
 * Resolve a dotted action path against an action tree and invoke it with
 * `input`. Used to adapt workspace actions into the generic
 * `dispatch(action, input)` callback that sync RPC expects.
 *
 * Throws if the path doesn't resolve to an action.
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
 * Sourced from `@epicenter/sync`'s `RpcError` so the wire and the remote-action
 * type surface share a single nominal `ActionFailed` — no re-wrapping between
 * layers, one `name` discriminant to match on.
 */
export type ActionFailed = Extract<RpcError, { name: 'ActionFailed' }>;

// ════════════════════════════════════════════════════════════════════════════
// REMOTE ACTION TYPES (RPC proxy surface)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Mirror an action tree's shape for remote invocation. Each leaf keeps its
 * input args and output `T`, and its error union widens by `RpcError` (to
 * cover transport failures: `ActionFailed`, `Disconnected`, etc.).
 */
export type RemoteActions<A extends Actions> = {
	[K in keyof A]: A[K] extends (
		...args: infer Args
	) => Promise<Result<infer T, infer E>>
		? (...args: Args) => Promise<Result<T, E | RpcError>>
		: A[K] extends Actions
			? RemoteActions<A[K]>
			: never;
};
