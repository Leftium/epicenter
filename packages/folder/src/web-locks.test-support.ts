/**
 * Test helper: a Web Locks stand-in for runtimes that have none.
 *
 * It is shared by every tab opened in this process. A plain request waits its
 * turn. With `ifAvailable`, a lock that is held or waited for calls back with
 * `null` at once and is never granted later. A `signal` that aborts while the
 * request still waits rejects and the callback is never called; once granted,
 * the signal changes nothing.
 */
import { afterAll } from 'bun:test';

type Lock = { name: string };
type Work<T> = (lock: Lock | null) => Promise<T> | T;
type Options = { ifAvailable?: boolean; signal?: AbortSignal };

function setNavigator(value: unknown) {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value,
	});
	return () => {
		if (original === undefined)
			delete (globalThis as { navigator?: unknown }).navigator;
		else Object.defineProperty(globalThis, 'navigator', original);
	};
}

/** Install the stand-in as `navigator.locks`. Returns the function that removes it. */
export function installWebLocks(): () => void {
	return setNavigator({ locks: createWebLocks() });
}

/** A stand-in lock manager of its own, shared by whoever is handed it. */
export function createWebLocks() {
	const tails = new Map<string, Promise<unknown>>();
	const busy = new Map<string, number>();
	const locks = {
		request<T>(
			name: string,
			optionsOrWork: Options | Work<T>,
			maybeWork?: Work<T>,
		): Promise<T> {
			const work = (
				typeof optionsOrWork === 'function' ? optionsOrWork : maybeWork
			) as Work<T>;
			const options = typeof optionsOrWork === 'function' ? {} : optionsOrWork;
			if (options.ifAvailable && (busy.get(name) ?? 0) > 0)
				return Promise.resolve(work(null));
			const { signal } = options;
			if (signal?.aborted) return Promise.reject(signal.reason);
			busy.set(name, (busy.get(name) ?? 0) + 1);
			let granted = false;
			const turn = async () => {
				if (signal?.aborted) throw signal.reason;
				granted = true;
				return work({ name });
			};
			const result = (tails.get(name) ?? Promise.resolve()).then(turn, turn);
			const done = () => {
				busy.set(name, (busy.get(name) ?? 1) - 1);
			};
			tails.set(name, result.then(done, done));
			if (signal === undefined) return result;
			return new Promise<T>((resolve, reject) => {
				signal.addEventListener('abort', () => {
					// Use a distinct error to test cancellation normalization.
					if (!granted)
						reject(new DOMException('Lock wait aborted', 'AbortError'));
				});
				result.then(resolve, reject);
			});
		},
	};
	return locks;
}

/**
 * Give every test in the calling file `navigator.locks`. A browser folder
 * makes no automatic commit without it.
 */
export function useWebLocks() {
	afterAll(installWebLocks());
}

/** Run `work` in a runtime with no `navigator.locks`, as an insecure page has. */
export async function withoutWebLocks<T>(work: () => Promise<T>): Promise<T> {
	const restore = setNavigator({});
	try {
		return await work();
	} finally {
		restore();
	}
}
