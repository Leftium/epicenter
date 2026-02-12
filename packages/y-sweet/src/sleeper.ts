/**
 * A cancellable timeout. Resolves after `timeout` ms, or immediately if `wake()` is called.
 */
export function createSleeper(timeout: number) {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, timeout);
	return { promise, wake: resolve };
}

export type Sleeper = ReturnType<typeof createSleeper>;
