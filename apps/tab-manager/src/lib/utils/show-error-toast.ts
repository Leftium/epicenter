import { toast } from 'svelte-sonner';

/**
 * Show an error toast when a Result contains an error, then pass the Result through.
 *
 * Works as both a `.then()` callback and a direct wrapper:
 *
 * @example
 * ```typescript
 * // Chainable — fire-and-forget in onclick handlers
 * bookmarkState.toggle(tab).then(showErrorToast);
 *
 * // Wrapping — when you need the result afterward
 * const { data, error } = showErrorToast(await bookmarkState.toggle(tab));
 *
 * // Works with void returns (early exits like `if (!tab.url) return`)
 * savedTabState.save(tab).then(showErrorToast);
 * ```
 */
export function showErrorToast<
	TResult extends { error?: { message: string } } | void | undefined,
>(result: TResult): TResult {
	if (result && 'error' in result && result.error) {
		toast.error(result.error.message);
	}
	return result;
}
