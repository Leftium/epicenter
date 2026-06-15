/**
 * Liveness probe for a pid. `process.kill(pid, 0)` sends no signal: it only
 * runs the kernel's existence + permission check for the target process.
 *
 * `EPERM` means the process exists but is owned by another user, so it is
 * still alive. A dead pid raises `ESRCH`, which returns `false`.
 *
 * Owned by `daemon down` (SIGTERM target guard); the `EPERM`-means-alive
 * branch is subtle enough that it should not be re-typed at the call site.
 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === 'EPERM';
	}
}
