/**
 * `DaemonActions<T>`: derive the daemon `/run` call shape of an action
 * source by walking its type and keeping only branded `defineQuery` /
 * `defineMutation` leaves.
 *
 * Pass the returned workspace type as `T` (typically
 * `ReturnType<typeof openFuji>`) and `DaemonActions<T>` filters it
 * to:
 *
 * - branded leaves at any depth become wire-callable and `Result`-wrapped
 *   via {@link WrapDaemonAction}
 * - non-branded functions (plain methods, callbacks, class methods) drop
 * - objects containing no branded descendants drop
 *
 * ## The depth bound
 *
 * Class instances like `Y.Doc` carry circular type references (`Doc._item.parent.doc.…`)
 * that send a naive recursive mapped type into TS2615 ("circularly references
 * itself"). The `Depth` parameter is a tuple-length counter: every recursion
 * appends a `1` and bails when it hits `MAX_DEPTH`. Eight levels is enough
 * for any realistic workspace action path and short enough to keep tsc fast if
 * a class instance appears on the workspace bundle.
 */

import type { Result } from 'wellcrafted/result';
import type { Action } from '../shared/actions.js';
import type { Simplify } from '../shared/types.js';
import type { RunError } from '../daemon/run-errors.js';
import type { DaemonError } from '../daemon/client.js';

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
 * tuple length: 8 levels covers every realistic action path nesting and
 * keeps the recursion bounded for class-instance properties.
 */
type MaxDepth = [1, 1, 1, 1, 1, 1, 1, 1];

type Inc<D extends ReadonlyArray<1>> = [...D, 1];
type AtLimit<D extends ReadonlyArray<1>> = D['length'] extends MaxDepth['length']
	? true
	: false;

/**
 * `true` if `T` is an object that contains at least one branded leaf at any
 * depth <= remaining `Depth` budget. Used as the cut-line for whether a
 * non-branded property survives `DaemonActions<T>`.
 */
type HasBrandedLeaves<T, D extends ReadonlyArray<1>> = AtLimit<D> extends true
	? false
	: T extends object
		? true extends {
				[K in keyof T]-?: IsDaemonKey<T[K], Inc<D>>;
			}[keyof T]
			? true
			: false
		: false;

/**
 * `true` if `V` should appear on the remote. Branded actions are always
 * kept; plain functions are always dropped; objects are kept only when
 * they recursively contain a branded leaf within the depth budget.
 */
type IsDaemonKey<V, D extends ReadonlyArray<1>> = V extends Action
	? true
	: V extends (...args: never[]) => unknown
		? false
		: V extends object
			? HasBrandedLeaves<V, D>
			: false;

/**
 * The daemon-callable shape of `T`. Branded leaves are awaited and
 * `Result`-wrapped; non-branded keys drop. Bounded recursion depth so
 * class-instance properties (Y.Doc, arktype Type, etc.) drop cleanly
 * without hitting TS2615.
 *
 * Wrapped in {@link Simplify} so IDE hover output shows the flattened
 * call shape rather than a wall of conditional types.
 */
export type DaemonActions<T, D extends ReadonlyArray<1> = []> =
	AtLimit<D> extends true
		? {}
		: Simplify<{
				[K in keyof T as IsDaemonKey<T[K], D> extends true
					? K
					: never]: T[K] extends Action
					? WrapDaemonAction<T[K]>
					: T[K] extends object
						? DaemonActions<T[K], Inc<D>>
						: never;
			}>;
