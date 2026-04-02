import { toast } from 'svelte-sonner';
import type { Result } from 'wellcrafted/result';

/**
 * Show an error toast when a Result contains an error, then pass the Result through.
 *
 * Works as both a `.then()` callback and a direct wrapper—the Result is
 * returned untouched so callers can still destructure `{ data, error }`.
 *
 * Accepts `void | undefined` so early returns (e.g. `if (!tab.url) return`)
 * don't require special handling at the call site.
 *
 * @example
 * ```typescript
 * // Chainable — fire-and-forget in onclick handlers
 * bookmarkState.toggle(tab).then(toastOnError);
 *
 * // Wrapping — when you need the result afterward
 * const { data, error } = toastOnError(await bookmarkState.toggle(tab));
 * if (error) return; // already toasted
 * ```
 */
export function toastOnError<
	TResult extends Result<unknown, { message: string }> | void | undefined,
>(result: TResult): TResult {
	if (result && 'error' in result && result.error) {
		toast.error(result.error.message);
	}
	return result;
}
