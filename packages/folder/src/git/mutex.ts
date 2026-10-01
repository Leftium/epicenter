/**
 * One piece of work at a time within this process.
 *
 * `run` waits for the work ahead of it. A `signal` that aborts while the work
 * is still waiting rejects with the signal's reason and the work never runs;
 * once the work has started the signal has no effect. `tryRun` starts only
 * when nothing is running or waiting, and otherwise returns `undefined`
 * without leaving anything behind.
 */
export function createMutex() {
	let tail = Promise.resolve();
	/** Work that is running or waiting its turn. */
	let held = 0;

	function run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		held++;
		let started = false;
		const turn = () => {
			signal?.throwIfAborted();
			started = true;
			return work();
		};
		// Uncontended work starts at once, so it is admitted by the time `run`
		// returns and an abort that follows cannot refuse it.
		const result =
			held === 1
				? new Promise<T>((resolve) => resolve(turn()))
				: tail.then(turn, turn);
		const done = () => {
			held--;
		};
		tail = result.then(done, done);
		if (signal === undefined) return result;
		// Tell an aborted waiter at once; its turn, when it comes, does nothing.
		return new Promise<T>((resolve, reject) => {
			const abort = () => {
				if (!started) reject(signal.reason);
			};
			signal.addEventListener('abort', abort, { once: true });
			result.then(
				(value) => {
					signal.removeEventListener('abort', abort);
					resolve(value);
				},
				(cause) => {
					signal.removeEventListener('abort', abort);
					reject(cause);
				},
			);
		});
	}

	return {
		run,
		tryRun<T>(work: () => Promise<T>): Promise<T> | undefined {
			return held > 0 ? undefined : run(work);
		},
	};
}
