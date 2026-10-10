/**
 * Work the page started and has not finished: a write, a delete, or a chat
 * message. Closing waits for it, so nothing lands on a closed folder.
 */
export function createAdmissions() {
	const running = new Set<Promise<unknown>>();
	return {
		/** Run `work`, counted from its first step until it settles. */
		admit<T>(work: () => Promise<T>): Promise<T> {
			const promise = work();
			running.add(promise);
			const done = () => running.delete(promise);
			promise.then(done, done);
			return promise;
		},
		/** Whether any admitted work is still running. */
		get busy() {
			return running.size > 0;
		},
		/** Resolve once no admitted work is running. */
		async quiet() {
			while (running.size > 0) await Promise.allSettled([...running]);
		},
	};
}

export type Admit = <T>(work: () => Promise<T>) => Promise<T>;
