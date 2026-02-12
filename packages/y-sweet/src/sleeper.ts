/**
 * Creates a cancellable timeout that resolves after `timeout` ms,
 * or immediately if {@link Sleeper.wake `wake()`} is called.
 *
 * @param timeout - Duration in milliseconds before the promise auto-resolves.
 * @returns A {@link Sleeper} with a `promise` to await and a `wake` function to resolve early.
 */
export function createSleeper(timeout: number) {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, timeout);
	return {
		/** Resolves when the timeout expires or `wake()` is called. */
		promise,
		/** Resolves the promise immediately, skipping the remaining timeout. */
		wake: resolve,
	};
}

/** A cancellable timeout returned by {@link createSleeper}. */
export type Sleeper = ReturnType<typeof createSleeper>;
