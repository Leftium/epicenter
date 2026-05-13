/**
 * Actions: typed queries (reads) and mutations (writes) authored as a flat
 * record keyed by snake_case key. `defineQuery`/`defineMutation` attach metadata
 * to the handler and return it. The action callable IS the handler, so local
 * callers see exactly what the author wrote (sync stays sync, `Result` stays
 * `Result`).
 *
 * One shape, two views:
 *
 *     ActionRegistry                       ActionManifest
 *     flat, callable                       flat, metadata-only
 *     local, in-memory                     wire form (peer.describe)
 *
 *     {                                    {
 *       tabs_close:   Action,                tabs_close:   { type, ... },
 *       'ping':       Action,                'ping':       { type, ... },
 *     }                                    }
 *
 * Functions don't serialize, so the wire form drops them and keeps just the
 * metadata. The wire form is "the registry minus handlers"; both views index
 * by the same snake_case key. There is no walker, no segment loop, no path
 * resolver: `Object.entries(actions)` is the iterator, `actions[key]` is
 * the lookup.
 *
 * Unknown local callers use `invokeAction`, which Ok-wraps raw values,
 * preserves existing Results, and catches throws as `RpcError.ActionFailed`.
 * RPC uses `invokeActionForRpc`, which also converts custom non-RPC errors
 * into `RpcError.ActionFailed` before the result crosses the wire. Remote
 * callers reach actions via `collaboration.peers.find(peerId)?.invoke(key, input)`,
 * which returns `Promise<Result<T, RemoteCallError>>`.
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

type ActionType = 'query' | 'mutation';

/**
 * Metadata properties attached to a callable action.
 *
 * `input` (a live `TSchema`) is present whenever the action defines one.
 * Action discovery returns this shape directly. There is no separate
 * wire form.
 */
export type ActionMeta<
	TInput extends TSchema | undefined = TSchema | undefined,
	TType extends ActionType = ActionType,
> = {
	type: TType;
	/** Short, human-readable display name for UI surfaces (e.g. 'Close Tabs'). Falls back to path-derived name if omitted. */
	title?: string;
	description?: string;
	input?: TInput;
};

/**
 * Flat snake_case key to `ActionMeta` map describing a peer's full action surface.
 * Returned by the `RUNTIME_REQUEST { verb: 'describe-actions' }` wire kind
 * and consumed via `collaboration.peers.find(peerId)?.describe()`.
 */
export type ActionManifest = Record<string, ActionMeta>;

/**
 * A query or mutation action definition. Callable function with metadata
 * properties attached. Queries are idempotent reads; mutations write. The
 * `type` discriminant lives on the value, so the type stays a single union
 * rather than three named aliases. The local callable shape IS the handler's
 * signature (sync stays sync, raw stays raw); remote/AI/CLI consumers see
 * uniform `Promise<Result<T, RpcError>>` via the boundary normalizers.
 */
export type Action<
	TInput extends TSchema | undefined = TSchema | undefined,
	R = unknown,
	TType extends ActionType = ActionType,
> = ActionHandler<TInput, R> & ActionMeta<TInput, TType>;

/**
 * Flat snake_case key to `Action` map. The single shape for an in-process
 * action surface: keys are the local address, peer RPC method, daemon
 * argument, CLI flag, and AI tool name. Author with `defineActions({...})`
 * so the helper enforces the key shape at compile time and at construction;
 * consumers iterate with `Object.entries` or index by string.
 */
export type ActionRegistry = Record<string, Action>;

// ════════════════════════════════════════════════════════════════════════════
// KEY VALIDATION (compile-time + runtime)
// ════════════════════════════════════════════════════════════════════════════

type Lower =
	| 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
	| 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z';
type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
type WordChar = Lower | Digit | '_';

/** Recursive tail check: every remaining char must be `[a-z0-9_]`. */
type IsActionKeyTail<S extends string> = S extends ''
	? true
	: S extends `${WordChar}${infer Rest}`
		? IsActionKeyTail<Rest>
		: false;

/**
 * `true` iff `S` matches `^[a-z][a-z0-9_]*$` at the type level. Length is
 * not checked here; the regex catches >64 at runtime. Verified empirically:
 * `arkregex` falls back to `string` for `[a-z]`-class patterns, so we
 * hand-write the template literal walk.
 */
type IsSnakeCaseKey<S extends string> = S extends `${Lower}${infer Rest}`
	? IsActionKeyTail<Rest> extends true
		? true
		: false
	: false;

/**
 * Branded type-level error returned from `ValidatedKey<S>` when `S` is not
 * a valid snake_case action key.
 *
 * The trailing `​` (Unicode zero-width space) makes this literal
 * structurally distinct from any plain string a user could type. TypeScript
 * renders the message in IDE error tooltips without showing the invisible
 * character, so the developer sees a clean English sentence:
 *
 *     Type 'Action' is not assignable to type
 *     'Invalid action key "tabs.close", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/'.
 *
 * Same pattern `@ark/util`'s internal `ErrorMessage<M>` uses. Inlined here
 * because that helper is not part of `arktype`'s public surface.
 */
type InvalidActionKey<S extends string> =
	`Invalid action key "${S}", must be snake_case ASCII matching /^[a-z][a-z0-9_]*$/​`;

/**
 * Regex enforcing `^[a-z][a-z0-9_]{0,63}$` at runtime. Exported so the CLI
 * and tests can share the same definition.
 */
export const ACTION_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Author an `ActionRegistry` with compile-time + runtime key validation.
 *
 * Compile time: each key is checked against the snake_case template-literal
 * type `IsSnakeCaseKey<K>`. A bad key (`'tabs.close'`, `'TabsClose'`,
 * `'0tab'`, `'_x'`) gets typed to `InvalidActionKey<K>` (a branded error
 * string) at that property, so the `Action` value the author wrote fails
 * to assign and TypeScript surfaces the error message at the edit site.
 *
 * Runtime: each key is checked against `ACTION_KEY_PATTERN` so dynamic
 * builders (`Object.fromEntries(...)`) and `as ActionRegistry` casts that
 * bypass the type still fail fast at construction.
 *
 * @example
 * ```ts
 * export function createFujiActions(tables: FujiTables) {
 *   return defineActions({
 *     entries_create: defineMutation({ ... }),
 *     entries_update: defineMutation({ ... }),
 *   });
 * }
 * export type FujiActions = ReturnType<typeof createFujiActions>;
 * ```
 */
export function defineActions<T extends ActionRegistry>(
	actions: {
		[K in keyof T & string]: IsSnakeCaseKey<K> extends true
			? T[K]
			: InvalidActionKey<K>;
	},
): T {
	for (const key of Object.keys(actions)) {
		if (!ACTION_KEY_PATTERN.test(key)) {
			throw new Error(
				`Invalid action key "${key}". Must match ${ACTION_KEY_PATTERN.source} (snake_case ASCII, starting with a letter, max 64 chars).`,
			);
		}
	}
	return actions as T;
}

/**
 * Define a query (read operation) with full type inference.
 *
 * Returns the handler with metadata attached. The action callable IS the
 * handler. Local callers see whatever the handler returns (sync if sync,
 * raw if raw, `Result` if explicit). Remote/AI/CLI consumers see uniform
 * `Promise<Result>` via the wire boundary in `invokeActionForRpc()` and
 * the peer dispatch path in `collaboration.peers.find(...)?.invoke(...)`.
 */
/** No input. `TInput` is explicitly `undefined`. */
export function defineQuery<R>(
	config: ActionConfig<undefined, R>,
): Action<undefined, R, 'query'>;
/** With input. `TInput` inferred from the schema. */
export function defineQuery<TInput extends TSchema, R>(
	config: ActionConfig<TInput, R>,
): Action<TInput, R, 'query'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineQuery({ handler, ...rest }: any): Action {
	return Object.assign(handler, {
		type: 'query' as const,
		...rest,
	}) as unknown as Action;
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
): Action<undefined, R, 'mutation'>;
/** With input. `TInput` inferred from the schema. */
export function defineMutation<TInput extends TSchema, R>(
	config: ActionConfig<TInput, R>,
): Action<TInput, R, 'mutation'>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineMutation({ handler, ...rest }: any): Action {
	return Object.assign(handler, {
		type: 'mutation' as const,
		...rest,
	}) as unknown as Action;
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
export function isQuery(
	value: unknown,
): value is Action<TSchema | undefined, unknown, 'query'> {
	return isAction(value) && value.type === 'query';
}

/**
 * Type guard to check if a value is a mutation action definition.
 */
export function isMutation(
	value: unknown,
): value is Action<TSchema | undefined, unknown, 'mutation'> {
	return isAction(value) && value.type === 'mutation';
}

/**
 * Project a callable action onto its wire-form metadata. Functions drop;
 * live schemas, titles, and descriptions are kept. Used at the two action
 * manifest boundaries (`peer.describe()` and the daemon `/list` route).
 */
export function toActionMeta({
	type,
	input,
	title,
	description,
}: Action): ActionMeta {
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
 * errors become `Err(RpcError.ActionFailed)`. This is intentionally an
 * in-process helper: a handler's custom `Err(E)` is preserved for local
 * callers. Use `invokeActionForRpc` at the wire boundary, where every error
 * must be an `RpcError`.
 *
 * `errorLabel` is required and appears as `action` on a returned
 * `RpcError.ActionFailed`. Every caller has the action key at the call site
 * (it's how it dispatched to the action), so pass it through; there is no
 * fallback chain.
 *
 * @example
 * ```ts
 * const result = await invokeAction<{ closedCount: number }>(
 *   workspace.actions.tabs_close,
 *   { tabIds: [1, 2] },
 *   'tabs_close',
 * );
 * if (result.error) { ... }
 * console.log(result.data.closedCount);
 * ```
 */
export async function invokeAction<T = unknown>(
	action: Action,
	input: unknown | undefined,
	errorLabel: string,
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
	input: unknown | undefined,
	errorLabel: string,
): Promise<Result<T, RpcError>> {
	const result = await invokeAction<T>(action, input, errorLabel);
	if (result.error === null) return result;
	if (isRpcError(result.error)) return result;
	return RpcError.ActionFailed({ action: errorLabel, cause: result.error });
}

// ════════════════════════════════════════════════════════════════════════════
// REMOTE CALL OPTIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Per-remote-call options. Threaded through `peer.invoke(path, input, options)`
 * and the daemon `/run` route as a trailing optional argument.
 *
 * Currently just `timeout`. Cancellation via `AbortSignal` is deliberately
 * out: the underlying wire does not support a CANCEL frame yet.
 */
export type RemoteCallOptions = {
	/** Per-call override of the default RPC timeout (ms). Default: 5000. */
	timeout?: number;
};
