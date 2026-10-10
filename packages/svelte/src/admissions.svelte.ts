/**
 * Admissions: the work a page has started and not finished, so closing or
 * leaving can wait for all of it.
 *
 * A command counts from the moment it is called, before its first await, so
 * no part of it can start after a close has stopped waiting. Wrap a whole
 * method with `command`, or one piece of work with `admit`. Which commands
 * are refused, and how a refusal reads, stays with the app.
 */
export function createAdmissions() {
	const running = new Set<Promise<unknown>>();
	let count = $state(0);

	function admit<T>(work: () => Promise<T>): Promise<T> {
		// Run now, so the work's synchronous start happens within the call.
		let started: Promise<T>;
		try {
			started = Promise.resolve(work());
		} catch (cause) {
			started = Promise.reject(cause);
		}
		running.add(started);
		count = running.size;
		const done = () => {
			running.delete(started);
			count = running.size;
		};
		started.then(done, done);
		return started;
	}

	return {
		/** Wrap a whole method: each call counts from the call until it settles. */
		command<TArgs extends unknown[], T>(
			work: (...args: TArgs) => Promise<T>,
		): (...args: TArgs) => Promise<T> {
			return (...args) => admit(() => work(...args));
		},
		/** Count one piece of work from now until it settles. */
		admit,
		/** Whether any admitted work is running, read tracked. */
		get busy() {
			return count > 0;
		},
		/** Wait until no admitted work runs, including work admitted meanwhile. */
		async quiet(): Promise<void> {
			while (running.size > 0) await Promise.allSettled([...running]);
		},
	};
}

export type Admissions = ReturnType<typeof createAdmissions>;
