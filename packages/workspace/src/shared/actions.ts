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
 ## Passthrough — local actions are the handler verbatim
 *
 * `defineMutation` and `defineQuery` attach metadata to the handler and return
 * it. The action callable IS the handler — sync if sync, raw if raw, `Result`
 * if explicit. Local callers see exactly what the author wrote.
 *
 * Transport-imposed shape (`Promise<Result<T, E | RpcError>>`) lives at the
 * boundary that has the transport: the wire (`createRemoteActions`) wraps;
 * generic in-process consumers (AI bridge, CLI dispatch, RPC server-side)
 * call `invokeNormalized(action, input, label)` to get the uniform shape.
 *
 * If a handler throws, the throw propagates to the local caller. The
 * boundary normalizers convert throws to `Err(ActionFailed)` automatically,
 * so AI/CLI/RPC consumers always see a Result. Local UI code that wants
 * Result-shaped output should either `tryAsync` the call or define the
 * handler to return `Result` explicitly.
 *
 * ## Exports
 *
 * - {@link defineQuery} - Define a read operation
 * - {@link defineMutation} - Define a write operation
 * - {@link isAction}, {@link isQuery}, {@link isMutation} - Type guards for action definitions
 *
 * @module
 */

import { RpcError } from '@epicenter/sync';
import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { Ok, isResult } from 'wellcrafted/result';

export { isResult };

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The handler function type, conditional on whether input is provided.
 *
 * Uses variadic tuple args instead of conditional function signatures so that
 * when the type flows through `Action` (via the `Actions` constraint), `any`
 * distributes over both branches giving `[input: any] | []` — which correctly
 * allows calling with 0 arguments for no-input actions.
 *
 * Parameterized on `R` (the handler's actual return type) rather than splitting
 * `TOutput`/`TError` — keeps the action's callable signature exactly equal to
 * the handler's, so passthrough preserves precision (no widening to a
 * `T | Result<T, E> | Promise<...>` union).
 */
type ActionHandler<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = (
	...args: TInput extends TSchema ? [input: Static<TInput>] : []
) => R;

/**
 * Configuration for defining an action (query or mutation).
 */
type ActionConfig<TInput extends TSchema | undefined, R> = {
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
	handler: ActionHandler<TInput, R>;
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
 * A query action definition (read operation).
 *
 * Queries are callable functions with metadata properties attached. They are
 * idempotent operations that read data without side effects. Local callable
 * shape IS the handler's signature (sync stays sync, raw stays raw); remote/
 * AI/CLI consumers see uniform `Promise<Result<T, E | RpcError>>` via the
 * boundary normalizers.
 */
export type Query<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = ActionHandler<TInput, R> & ActionMeta<TInput> & { type: 'query' };

/**
 * A mutation action definition (write operation).
 *
 * Mutations are callable functions with metadata properties attached. Local
 * callable shape IS the handler's signature; remote/AI/CLI consumers see
 * uniform `Promise<Result<T, E | RpcError>>` via the boundary normalizers.
 */
export type Mutation<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = ActionHandler<TInput, R> & ActionMeta<TInput> & { type: 'mutation' };

/**
 * Union type of Query and Mutation action definitions.
 */
export type Action<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = Query<TInput, R> | Mutation<TInput, R>;

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
	[key: string]: Action<any, any> | Actions;
};

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns the handler with metadata attached — the action callable IS the
 * handler. Local callers see whatever the handler returns (sync if sync,
 * raw if raw, `Result` if explicit). Remote/AI/CLI consumers see uniform
 * `Promise<Result>` via the boundary normalizers (`createRemoteActions`,
 * `invokeNormalized`).
 */
/** No input — `TInput` is explicitly `undefined`. */
export function defineQuery<R>(
	config: ActionConfig<undefined, R>,
): Query<undefined, R>;
/** With input — `TInput` inferred from the schema. */
export function defineQuery<TInput extends TSchema, R>(
	config: ActionConfig<TInput, R>,
): Query<TInput, R>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineQuery({ handler, ...rest }: any): Query {
	return Object.assign(handler, {
		type: 'query' as const,
		...rest,
	}) as unknown as Query;
}

/**
 * Define a mutation (write operation) with full type inference.
 *
 * Returns the handler with metadata attached — the action callable IS the
 * handler. Local callers see whatever the handler returns; remote/AI/CLI
 * consumers see uniform `Promise<Result>` via the boundary normalizers.
 */
/** No input — `TInput` is explicitly `undefined`. */
export function defineMutation<R>(
	config: ActionConfig<undefined, R>,
): Mutation<undefined, R>;
/** With input — `TInput` inferred from the schema. */
export function defineMutation<TInput extends TSchema, R>(
	config: ActionConfig<TInput, R>,
): Mutation<TInput, R>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineMutation({ handler, ...rest }: any): Mutation {
	return Object.assign(handler, {
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

/**
 * Invoke an action and normalize its return into a uniform
 * `Promise<Result<T, RpcError>>`.
 *
 * The single canonical normalize: raw values get `Ok`-wrapped, existing
 * `Result`s pass through, and thrown errors become `Err(ActionFailed)`. Used
 * by every consumer that doesn't know the handler shape ahead of time —
 * AI tool bridge, CLI dispatch, and the inbound RPC handler.
 *
 * The `errorLabel` (defaulting to `action.title` or `'anonymous'`) appears
 * as `action` on the returned `RpcError.ActionFailed`, so callers see
 * meaningful context in error reports without the util needing the dotted
 * path itself.
 *
 * @example
 * ```ts
 * const result = await invokeNormalized<{ closedCount: number }>(
 *   workspace.actions.tabs.close,
 *   { tabIds: [1, 2] },
 *   'tabs.close',
 * );
 * if (result.error) { ... }
 * console.log(result.data.closedCount);
 * ```
 */
export async function invokeNormalized<T = unknown>(
	action: Action,
	input?: unknown,
	errorLabel: string = action.title ?? 'anonymous',
): Promise<Result<T, RpcError>> {
	try {
		const ret =
			action.input !== undefined
				? await (action as (i: unknown) => unknown)(input)
				: await (action as () => unknown)();
		return (isResult(ret) ? ret : Ok(ret)) as Result<T, RpcError>;
	} catch (cause) {
		return RpcError.ActionFailed({ action: errorLabel, cause });
	}
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
 * Compute the wrapped shape of a single action callable for remote/normalized
 * consumption. Four flat branches:
 *
 * - `(...) => Promise<Result<T, E>>` → `(...) => Promise<Result<T, E | RpcError>>`
 * - `(...) => Promise<R>`            → `(...) => Promise<Result<R, RpcError>>`
 * - `(...) => Result<T, E>`          → `(...) => Promise<Result<T, E | RpcError>>`
 * - `(...) => R`                     → `(...) => Promise<Result<R, RpcError>>`
 *
 * The data type is unchanged; the error union widens by `RpcError` (to cover
 * transport failures: `ActionFailed`, `Disconnected`, etc.).
 */
export type WrapAction<F> = F extends (...args: infer Args) => infer R
	? R extends Promise<infer Inner>
		? Inner extends Result<infer T, infer E>
			? (...args: Args) => Promise<Result<T, E | RpcError>>
			: (...args: Args) => Promise<Result<Inner, RpcError>>
		: R extends Result<infer T, infer E>
			? (...args: Args) => Promise<Result<T, E | RpcError>>
			: (...args: Args) => Promise<Result<R, RpcError>>
	: never;

/**
 * Mirror an action tree's shape for remote invocation. Each leaf is wrapped
 * via {@link WrapAction} so callers see uniform `Promise<Result<T, E | RpcError>>`
 * regardless of the underlying handler's shape.
 */
export type RemoteActions<A extends Actions> = {
	[K in keyof A]: A[K] extends Action
		? WrapAction<A[K]>
		: A[K] extends Actions
			? RemoteActions<A[K]>
			: never;
};
