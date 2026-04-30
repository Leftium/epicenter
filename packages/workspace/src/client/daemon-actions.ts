/**
 * `buildDaemonActions`: typed proxy that turns a `DaemonClient` into an
 * action-root facade. Local call sites use the same dotted path they would
 * under `workspace.actions` (`tabs.open(...)`); each call dispatches
 * over the unix socket via `client.run`.
 *
 * The proxy is a single recursive `Proxy` rooted at the action shape.
 * Property access walks the chain and accumulates path segments; calling
 * the resulting proxy invokes `client.run` with the joined dotted path.
 *
 * `then` is masked at every level so an accidental `await actions.tabs`
 * does not turn an intermediate namespace into a thenable and pollute the
 * path with a stray `.then` segment.
 */

import type { Result } from 'wellcrafted/result';
import type { DaemonClient, DaemonError } from '../daemon/client.js';
import type { RunError } from '../daemon/run-errors.js';
import type { Action } from '../shared/actions.js';
import type { Simplify } from '../shared/types.js';

const DEFAULT_RUN_WAIT_MS = 5_000;

/**
 * `DaemonActions<T>`: derive the daemon `/run` call shape of an action
 * source by walking its type and keeping only branded `defineQuery` /
 * `defineMutation` leaves.
 *
 * Pass the canonical action root type as `T` (typically
 * `ReturnType<typeof openFuji>['actions']`) and `DaemonActions<T>` filters it
 * to:
 *
 * - branded leaves at any depth become wire-callable and `Result`-wrapped
 *   via {@link WrapDaemonAction}
 * - non-branded functions and arrays drop
 * - objects containing no branded descendants drop
 *
 * The runtime walker only descends into plain objects. TypeScript cannot
 * reliably distinguish plain objects from class instances, so this type is a
 * bounded approximation of that runtime rule.
 */
export type DaemonActionOptions = {
	/** Override the daemon `/run` wait budget in milliseconds. */
	waitMs?: number;
};

type WithDaemonOptions<Args extends readonly unknown[]> = Args extends []
	? [input?: undefined, options?: DaemonActionOptions]
	: [...Args, options?: DaemonActionOptions];

type DaemonSuccessOutput<TOutput> =
	Awaited<TOutput> extends Result<infer TData, unknown>
		? TData
		: Awaited<TOutput>;

type WrapDaemonAction<F> = F extends (...args: infer Args) => infer R
	? (
			...args: WithDaemonOptions<Args>
		) => Promise<Result<DaemonSuccessOutput<R>, RunError | DaemonError>>
	: never;

/**
 * Recursion depth bound for `DaemonActions<T>` and its helpers. Counted as a
 * tuple length: 8 levels covers every realistic action path nesting and keeps
 * the recursion bounded for class-instance properties.
 */
type MaxDepth = [1, 1, 1, 1, 1, 1, 1, 1];

type Inc<D extends ReadonlyArray<1>> = [...D, 1];
type AtLimit<D extends ReadonlyArray<1>> =
	D['length'] extends MaxDepth['length'] ? true : false;

/**
 * `true` if `T` is an object that contains at least one branded leaf at any
 * depth <= remaining `Depth` budget. Used as the boundary for whether a
 * non-branded property survives `DaemonActions<T>`.
 */
type HasBrandedLeaves<T, D extends ReadonlyArray<1>> =
	AtLimit<D> extends true
		? false
		: T extends readonly unknown[]
			? false
			: T extends object
				? true extends {
						[K in keyof T & string]-?: ActionPathKey<K> extends never
							? false
							: IsDaemonKey<T[K], Inc<D>>;
					}[keyof T & string]
					? true
					: false
				: false;

/**
 * `true` if `V` should appear on the daemon facade. Branded actions are kept;
 * plain functions and arrays are dropped; objects are kept only when they
 * recursively contain a branded leaf within the depth budget.
 */
type IsDaemonKey<V, D extends ReadonlyArray<1>> = V extends Action
	? true
	: V extends (...args: never[]) => unknown
		? false
		: V extends readonly unknown[]
			? false
			: V extends object
				? HasBrandedLeaves<V, D>
				: false;

/**
 * The daemon-callable shape of `T`. Branded leaves are awaited and
 * `Result`-wrapped; non-branded keys drop. Bounded recursion depth keeps
 * class-instance properties from hitting TS2615.
 *
 * Wrapped in {@link Simplify} so IDE hover output shows the flattened call
 * shape rather than a wall of conditional types.
 */
export type DaemonActions<T, D extends ReadonlyArray<1> = []> =
	AtLimit<D> extends true
		? {}
		: Simplify<{
				[K in keyof T & string as ActionPathKey<K> extends never
					? never
					: IsDaemonKey<T[K], D> extends true
						? K
						: never]: T[K] extends Action
					? WrapDaemonAction<T[K]>
					: T[K] extends readonly unknown[]
						? never
						: T[K] extends object
							? DaemonActions<T[K], Inc<D>>
							: never;
			}>;

type ActionPathKey<TKey extends string> = TKey extends ''
	? never
	: TKey extends `${string}.${string}`
		? never
		: TKey;

/**
 * Recursive proxy rooted at the action shape. Property access produces another
 * proxy carrying the path-so-far; calling the proxy dispatches `client.run`
 * with the joined dotted path.
 *
 * `function () {}` is the proxy target so `apply` is reachable. The `then`
 * key is masked everywhere on the path (otherwise an `await` on an
 * intermediate namespace would turn it into a thenable).
 */
function buildDaemonActionProxy(
	client: DaemonClient,
	workspaceExportName: string,
): unknown {
	const make = (path: string[]): unknown => {
		const target = (() => {}) as unknown as object;
		return new Proxy(target, {
			get(_target, prop) {
				if (typeof prop !== 'string') return undefined;
				if (prop === 'then') return undefined;
				return make([...path, prop]);
			},
			apply(_target, _thisArg, args) {
				const input = args.length === 0 ? undefined : args[0];
				const { waitMs = DEFAULT_RUN_WAIT_MS } =
					(args[1] as DaemonActionOptions | undefined) ?? {};
				return client.run({
					actionPath: `${workspaceExportName}.${path.join('.')}`,
					input,
					waitMs,
				});
			},
		});
	};
	return make([]);
}

/**
 * Compose the daemon action facade. Generic `TActions` is the in-process
 * action root shape; `DaemonActions<TActions>` filters it to branded leaves
 * only and rewrites each leaf to the daemon `/run` result.
 */
export function buildDaemonActions<TActions>(
	client: DaemonClient,
	workspaceExportName: string,
): DaemonActions<TActions> {
	return buildDaemonActionProxy(
		client,
		workspaceExportName,
	) as DaemonActions<TActions>;
}
