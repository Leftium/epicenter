/**
 * Run-at-most-once wrapper.
 *
 * Wrap `fn` so the first call invokes it and caches the result; every later
 * call is a no-op that returns that same cached result. Arguments passed after
 * the first call are ignored.
 *
 * The canonical use is an idempotent `[Symbol.dispose]`. When a resource's
 * teardown is reachable from more than one path (an explicit `wipe()` plus a
 * `using` scope exit, say), the teardown must not run twice. `once` makes that
 * guarantee declarative instead of hand-rolling a `let disposed` flag.
 *
 * This is for the pure "this function body runs at most once" case. A boolean
 * that is *also* read by other methods to short-circuit a dead object
 * (`if (disposed) return` scattered across setters and event handlers) is a
 * liveness flag, not a once-guard: keep the boolean there, `once` does not
 * replace it.
 */

/**
 * Wrap `fn` so it runs at most once; later calls return the first result.
 *
 * @example
 * ```ts
 * const dispose = once(() => teardown());
 * dispose();  // teardown runs
 * dispose();  // no-op, returns the same result
 * ```
 */
export function once<TArgs extends readonly unknown[], TReturn>(
	fn: (...args: TArgs) => TReturn,
): (...args: TArgs) => TReturn {
	let called = false;
	let result: TReturn;
	return (...args: TArgs): TReturn => {
		if (!called) {
			called = true;
			result = fn(...args);
		}
		return result;
	};
}
