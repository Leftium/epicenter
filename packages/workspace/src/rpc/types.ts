import type { Static, TSchema } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type { Action } from '../shared/actions.js';

/**
 * Low-level `sync.rpc(...)` contract inferred from an action source.
 *
 * The transport sends one dot-path string such as `'tabs.close'`, so this
 * type mirrors that wire shape as a flat action map. App code should usually
 * prefer `createRemoteActions<T>(sync, deviceId)` for nested calls; use this
 * type when calling the lower-level `sync.rpc<TMap>(clientId, action, input)`
 * API.
 *
 * @example
 * ```typescript
 * // Tab-manager exports its actions type:
 * export type TabManagerRpc = InferSyncRpcMap<typeof workspace>;
 * // Resolves to:
 * // {
 * //   'tabs.close': { input: { tabIds: number[] }; output: { closedCount: number } }
 * //   'tabs.list':  { input: undefined; output: { tabs: Tab[] } }
 * // }
 *
 * // CLI imports it for typed RPC:
 * import type { TabManagerRpc } from '@epicenter/tab-manager/rpc';
 * const { data } = await workspace.sync.rpc<TabManagerRpc>(
 *   peer.clientId,
 *   'tabs.close',
 *   { tabIds: [1] },
 * );
 * // string action autocompletes, input is type-checked
 * // data is { closedCount: number } | null
 * ```
 */
export type InferSyncRpcMap<T> = FlattenToIntersection<FlattenActions<T>>;

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Walk an action source. For each leaf (Action), emit a Record<dotPath, { input, output }>.
 * For each branch (nested object), recurse with the key appended to the prefix.
 * Returns a union of single-key Records.
 */
type FlattenActions<T, TPrefix extends string = ''> = {
	[K in keyof T & string]: ActionPathKey<K> extends never
		? never
		: [T[K]] extends [Action<infer TInput, infer TOutput>]
			? Record<
					`${TPrefix}${K}`,
					{
						input: TInput extends TSchema ? Static<TInput> : undefined;
						output: RpcSuccessOutput<TOutput>;
					}
				>
			: T[K] extends readonly unknown[]
				? never
				: T[K] extends Record<string, unknown>
					? FlattenActions<T[K], `${TPrefix}${K}.`>
					: never;
}[keyof T & string];

type ActionPathKey<TKey extends string> = TKey extends ''
	? never
	: TKey extends `${string}.${string}`
		? never
		: TKey;

type RpcSuccessOutput<TOutput> =
	Awaited<TOutput> extends Result<infer TData, unknown>
		? TData
		: Awaited<TOutput>;

/** Collapse a union of Records into a single flat Record. */
type FlattenToIntersection<TUnion> = (
	TUnion extends unknown
		? (k: TUnion) => void
		: never
) extends (k: infer TIntersection) => void
	? { [K in keyof TIntersection]: TIntersection[K] }
	: never;

/**
 * Default RPC action map when no type parameter is provided.
 * Accepts any string action with unknown input/output.
 */
export type DefaultRpcMap = Record<string, { input: unknown; output: unknown }>;

/**
 * Constraint for the TMap generic parameter on `rpc()`.
 *
 * Uses `any` (not `unknown`) for input/output because generic constraints
 * need covariant compatibility: `{ input: string }` must extend
 * `{ input: any }` but does NOT extend `{ input: unknown }`.
 */
export type RpcActionMap = Record<string, { input: any; output: any }>;
