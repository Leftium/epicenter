/**
 * Reading a list from the folder again whenever asked, without losing a
 * change to timing.
 *
 * One read runs at a time. A request that arrives while one runs is not
 * dropped: the read in flight may have listed the folder before the change
 * that prompted the request, so one more read follows it. A read that reports
 * itself stale, because a save's receipt was applied while it was out, is
 * also followed by another, so what it listed besides that save is not lost.
 *
 * `readOnce` answers whether what it read was applied. The returned function
 * resolves once no read is running or owed.
 */
export function createReread(
	readOnce: () => Promise<boolean>,
): () => Promise<void> {
	let running: Promise<void> | undefined;
	let owed = false;
	return () => {
		if (running) {
			owed = true;
			return running;
		}
		running = (async () => {
			try {
				do {
					owed = false;
					if (!(await readOnce())) owed = true;
				} while (owed);
			} finally {
				running = undefined;
			}
		})();
		return running;
	};
}
