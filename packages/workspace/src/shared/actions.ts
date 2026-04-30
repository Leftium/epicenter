/**
 * Actions: typed queries (reads) and mutations (writes) authored as a nested
 * tree of closures. `defineQuery`/`defineMutation` attach metadata to the
 * handler and return it. The action callable IS the handler, so local
 * callers see exactly what the author wrote (sync stays sync, `Result` stays
 * `Result`).
 *
 * Two shapes for the same data:
 *
 *     Actions                       <->    ActionManifest
 *     nested, callable                     flat, metadata-only
 *     local, in-memory                     wire form (system.describe)
 *
 *     {                                    {
 *       tabs: { close: Mutation },           "tabs.close": { type, ... },
 *       ping: Query,                         "ping":       { type, ... },
 *     }                                    }
 *
 * Functions don't serialize, so the wire form drops them and keeps just the
 * metadata. Both shapes are public; `describeActions(tree)` converts.
 * `walkActions(tree)` is the underlying iterator. It yields live `[path, Action]`
 * pairs for callers that want to filter, invoke, or count instead of
 * materializing the full record.
 *
 * Unknown local callers use `invokeAction`, which Ok-wraps raw values,
 * preserves existing Results, and catches throws as `RpcError.ActionFailed`.
 * RPC uses `invokeActionForRpc`, which also converts custom non-RPC errors
 * into `RpcError.ActionFailed` before the result crosses the wire. Remote
 * callers use `createRemoteActions`, whose leaves expose
 * `Promise<Result<T, RpcError>>`.
 *
 * @module
 */

import { isRpcError, RpcError } from '@epicenter/sync';
import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import { isResult, Ok } from 'wellcrafted/result';

// ════════════════════════════════════════════════════════════════════════════
// ACTION DEFINITION TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * The handler function type, conditional on whether input is provided.
 *
 * Uses variadic tuple args instead of conditional function signatures so that
 * `any` distributes over both branches giving `[input: any] | []`, which
 * correctly allows calling with 0 arguments for no-input actions when the type
 * flows through `Action` with wildcard parameters.
 *
 * Parameterized on `R` (the handler's actual return type) rather than splitting
 * `TOutput`/`TError`: keeps the action's callable signature exactly equal to
 * the handler's, so passthrough preserves precision (no widening to a
 * `T | Result<T, E> | Promise<...>` union).
 */
type ActionHandler<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
> = (...args: TInput extends TSchema ? [input: Static<TInput>] : []) => R;

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
 *
 * `input` (a live `TSchema`) is present whenever the action defines one.
 * Action discovery returns this shape directly. There is no separate
 * wire form.
 */
export type ActionMeta<
	TInput extends TSchema | undefined = TSchema | undefined,
> = {
	type: 'query' | 'mutation';
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
};

/**
 * Flat dot-path to `ActionMeta` map describing a peer's full action surface.
 * Returned by the runtime-injected `system.describe` RPC and consumed via
 * `describeRemoteActions({ presence, rpc }, peerId)`.
 */
export type ActionManifest = Record<string, ActionMeta>;

/**
 * A query action definition (read operation).
 *
 * Queries are callable functions with metadata properties attached. They are
 * idempotent operations that read data without side effects. Local callable
 * shape IS the handler's signature (sync stays sync, raw stays raw); remote/
 * AI/CLI consumers see uniform `Promise<Result<T, RpcError>>` via the
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
 * uniform `Promise<Result<T, RpcError>>` via the boundary normalizers.
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
 * Shape suggestion for a "pure action tree" authoring style: nested objects
 * whose leaves are all `Action` definitions.
 *
 * Not load-bearing on any public signature. `walkActions` filters action
 * leaves at runtime via `isAction`, so action definitions can sit alongside
 * workspace infrastructure. Use this type if you genuinely want to annotate a
 * return as "tree of actions only"; otherwise let the inferred type do the
 * talking.
 *
 * Uses `any` for the action's input/output positions so specific
 * `Query<I, T>` / `Mutation<I, T>` instances assign cleanly through the
 * variadic-args distribution trick.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Actions = {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: Action<any, any> | Actions;
};

/**
 * Mark a plain action registry while preserving its exact inferred shape.
 *
 * This is intentionally an identity function. CLI and RPC adapters do not
 * require this wrapper; they discover any `defineQuery` / `defineMutation`
 * leaves reachable through plain objects. Use `defineActions` when you want
 * to name a grouped set of actions and keep its type tidy.
 */
export function defineActions<TActions extends Actions>(
	actions: TActions,
): TActions {
	return actions;
}

/**
 * The runtime-injected `system.*` action namespace. Single canonical type:
 * `attachRpc` constructs `systemActions: SystemActions` and `remote-actions.ts`
 * derives the proxy type `createRemoteActions<{ system: SystemActions }>` from
 * the same source. Drift between the runtime handler return and the consumer's
 * expected return becomes a compile error.
 */
export type SystemActions = {
	describe: Query<undefined, ActionManifest>;
};

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns the handler with metadata attached. The action callable IS the
 * handler. Local callers see whatever the handler returns (sync if sync,
 * raw if raw, `Result` if explicit). Remote/AI/CLI consumers see uniform
 * `Promise<Result>` via the boundary normalizers (`createRemoteActions()` for
 * callers, `invokeActionForRpc()` for the inbound wire).
 */
/** No input. `TInput` is explicitly `undefined`. */
export function defineQuery<R>(
	config: ActionConfig<undefined, R>,
): Query<undefined, R>;
/** With input. `TInput` inferred from the schema. */
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
 * Returns the handler with metadata attached. The action callable IS the
 * handler. Local callers see whatever the handler returns; remote/AI/CLI
 * consumers see uniform `Promise<Result>` via the boundary normalizers.
 */
/** No input. `TInput` is explicitly `undefined`. */
export function defineMutation<R>(
	config: ActionConfig<undefined, R>,
): Mutation<undefined, R>;
/** With input. `TInput` inferred from the schema. */
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
 * Structural check: anything callable with a `type` of `'query'` or
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
 * `true` iff `v` is a plain object literal (constructor is `Object` or
 * prototype is `null`). Bounds {@link walkActions} so it doesn't recurse
 * into class instances like `Y.Doc`, arktype `Type`, or `SvelteMap`:
 * those carry methods on their prototype and have no business being walked.
 * This makes passing a full workspace object safe: plain object branches are
 * treated as public path segments, class-backed infrastructure is skipped.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== 'object' || v === null) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === null || proto === Object.prototype;
}

function isValidActionKey(key: string) {
	return key !== '' && !key.includes('.');
}

function assertValidActionKey(key: string, path: string) {
	if (key === '') throw new Error(`Action keys cannot be empty at "${path}"`);
	if (key.includes('.')) {
		throw new Error(`Action keys cannot contain "." at "${path}"`);
	}
}

/**
 * Resolve a dotted path against an action tree (or any string-keyed object),
 * returning the leaf `Action` if the path lands on one. Returns `undefined`
 * for missing paths or paths that resolve to a namespace.
 *
 * Typed `Record<string, unknown>` so callers can pass a full workspace object
 * or a narrower action tree without losing nested path support.
 */
export function resolveActionPath(
	actions: Record<string, unknown>,
	path: string,
): Action | undefined {
	const segments = path.split('.');
	let target: unknown = actions;
	for (const segment of segments) {
		if (!isValidActionKey(segment)) return undefined;
		if (!isPlainObject(target)) return undefined;
		if (!Object.hasOwn(target, segment)) return undefined;
		target = (target as Record<string, unknown>)[segment];
	}
	return isAction(target) ? target : undefined;
}

/**
 * Lazily yield every action in a tree as `[dotPath, Action]` pairs. Order
 * is depth-first, left-to-right by author definition (Object key order).
 * Yields live callables. Invoke them, inspect them, or strip to metadata
 * via {@link describeActions}.
 *
 * Recursion only descends into plain object literals. Class instances
 * (`Y.Doc`, arktype `Type`, etc.) and functions short-circuit, so a returned
 * workspace bundle can be used directly. Any action leaf reachable through
 * plain object properties is part of the public path surface.
 *
 * Pair with `Object.fromEntries`, `Array.from`, or a `for…of` loop:
 * ```ts
 * for (const [path, action] of walkActions(workspace)) {
 *   if (action.type === 'mutation') console.log(path);
 * }
 * ```
 */
export function* walkActions(
	actions: Record<string, unknown>,
	prefix = '',
): Generator<[string, Action]> {
	for (const [key, value] of Object.entries(actions)) {
		const path = prefix ? `${prefix}.${key}` : key;
		if (isAction(value)) {
			assertValidActionKey(key, path);
			yield [path, value];
		} else if (isPlainObject(value)) {
			assertValidActionKey(key, path);
			yield* walkActions(value, path);
		}
	}
}

/**
 * Walk a tree into its flat `ActionManifest`: the wire form returned by
 * `system.describe`. Live `input` schemas are retained; functions are
 * dropped. Pairs with `describeRemoteActions({ presence, rpc }, peerId)`,
 * which returns the same shape from a remote peer.
 *
 * Built atop {@link walkActions}. Use that primitive directly if you want
 * to iterate live callables instead of metadata.
 */
export function describeActions(
	actions: Record<string, unknown>,
): ActionManifest {
	return Object.fromEntries(
		Array.from(walkActions(actions), ([path, action]) => [
			path,
			toMeta(action),
		]),
	);
}

function toMeta({ type, input, title, description }: Action): ActionMeta {
	const meta: ActionMeta = { type };
	if (input !== undefined) meta.input = input;
	if (title !== undefined) meta.title = title;
	if (description !== undefined) meta.description = description;
	return meta;
}

/**
 * Invoke an action when the caller does not statically know the handler
 * return shape.
 *
 * Raw values get `Ok`-wrapped, existing `Result`s pass through, and thrown
 * errors become `Err(ActionFailed)`. This is intentionally an in-process
 * helper: a handler's custom `Err(E)` is preserved for local callers. Use
 * `invokeActionForRpc` at the wire boundary, where every error must be an
 * `RpcError`.
 *
 * The `errorLabel` (defaulting to `action.title` or `'anonymous'`) appears
 * as `action` on the returned `RpcError.ActionFailed`, so callers see
 * meaningful context in error reports without the util needing the dotted
 * path itself.
 *
 * @example
 * ```ts
 * const result = await invokeAction<{ closedCount: number }>(
 *   workspace.tabs.close,
 *   { tabIds: [1, 2] },
 *   'tabs.close',
 * );
 * if (result.error) { ... }
 * console.log(result.data.closedCount);
 * ```
 */
export async function invokeAction<T = unknown>(
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

/**
 * Invoke an action for the RPC wire boundary.
 *
 * This keeps the remote contract honest: every failure crossing the sync RPC
 * channel is an `RpcError`. Raw values and Ok Results preserve their success
 * data. Thrown errors and custom `Err(E)` values become
 * `RpcError.ActionFailed`, with the original error under `cause`.
 */
export async function invokeActionForRpc<T = unknown>(
	action: Action,
	input?: unknown,
	errorLabel: string = action.title ?? 'anonymous',
): Promise<Result<T, RpcError>> {
	const result = await invokeAction<T>(action, input, errorLabel);
	if (result.error === null) return result;
	if (isRpcError(result.error)) return result;
	return RpcError.ActionFailed({ action: errorLabel, cause: result.error });
}

// ════════════════════════════════════════════════════════════════════════════
// ACTION FAILED (transport envelope)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Transport-layer error for actions invoked over RPC.
 *
 * Sourced from `@epicenter/sync`'s `RpcError` so the wire and the remote-action
 * type surface share a single nominal `ActionFailed`. There is one `name`
 * discriminant to match on.
 */
export type ActionFailed = Extract<RpcError, { name: 'ActionFailed' }>;

// ════════════════════════════════════════════════════════════════════════════
// REMOTE ACTION TYPES (RPC proxy surface)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Per-remote-call options, threaded through every wrapped leaf as a trailing
 * optional argument. The proxy passes these to `rpc.rpc(...)` directly:
 * same shape, same name, single source of truth.
 *
 * Currently just `timeout`. Cancellation via `AbortSignal` is deliberately
 * out. The underlying transport doesn't support it (a real cancel requires
 * a CANCEL frame the server understands). Add when plumbed through.
 */
export type RemoteCallOptions = {
	/** Per-call override of the default RPC timeout (ms). Default: 5000. */
	timeout?: number;
};

/**
 * Append an optional `RemoteCallOptions` parameter to an existing arg tuple.
 * No-arg handlers `(): R` become `(input?: undefined, options?: RemoteCallOptions) => ...`
 * so callers can always pass options as the second arg, regardless of whether
 * the action has input.
 */
type WithOptions<Args extends readonly unknown[]> = Args extends []
	? [input?: undefined, options?: RemoteCallOptions]
	: [...Args, options?: RemoteCallOptions];

/**
 * Compute the wrapped shape of a single action callable for remote/normalized
 * consumption. Four flat branches:
 *
 * - `(...) => Promise<Result<T, E>>` -> `(...) => Promise<Result<T, RpcError>>`
 * - `(...) => Promise<R>`            -> `(...) => Promise<Result<R, RpcError>>`
 * - `(...) => Result<T, E>`          -> `(...) => Promise<Result<T, RpcError>>`
 * - `(...) => R`                     -> `(...) => Promise<Result<R, RpcError>>`
 *
 * The success data type is unchanged. Custom non-RPC `Err(E)` values cross
 * the wire as `RpcError.ActionFailed` with the original error under `cause`,
 * so the remote type exposes only `RpcError`. Every wrapped leaf accepts a
 * trailing `RemoteCallOptions` for per-call overrides.
 */
export type WrapAction<F> = F extends (...args: infer Args) => infer R
	? (
			...args: WithOptions<Args>
		) => Promise<Result<RemoteSuccessOutput<R>, RpcError>>
	: never;

type RemoteSuccessOutput<TOutput> =
	Awaited<TOutput> extends Result<infer TData, unknown>
		? TData
		: Awaited<TOutput>;

/**
 * Filter any object `T` down to its action-shaped leaves and wrap each leaf
 * via {@link WrapAction} so callers see uniform `Promise<Result<T, RpcError>>`.
 *
 * Pass a pure action tree or a workspace bundle: non-action keys are removed
 * at the type level via key-remapping. Subtrees that contain zero actions are
 * also pruned, so consumers only see paths that lead somewhere callable.
 *
 * Bracketed `[T[K]] extends [Action]` form is intentional: prevents
 * unwanted distribution if a key's type is a union (e.g., `Foo | undefined`).
 */
export type RemoteActionProxy<T> = {
	[K in keyof T & string as ActionPathKey<K> extends never
		? never
		: [T[K]] extends [Action]
			? K
			: T[K] extends readonly unknown[]
				? never
				: T[K] extends Record<string, unknown>
					? keyof RemoteActionProxy<T[K]> extends never
						? never
						: K
					: never]: [T[K]] extends [Action]
		? WrapAction<T[K]>
		: T[K] extends readonly unknown[]
			? never
			: T[K] extends Record<string, unknown>
				? RemoteActionProxy<T[K]>
				: never;
};

type ActionPathKey<TKey extends string> = TKey extends ''
	? never
	: TKey extends `${string}.${string}`
		? never
		: TKey;
