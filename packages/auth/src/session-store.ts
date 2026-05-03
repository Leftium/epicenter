import type { AuthSession } from './auth-types.ts';

/**
 * Persistence boundary that `createAuth` uses to load, save, and observe the
 * browser session. Core auth owns the in-memory snapshot; storage only moves
 * data across the durable boundary.
 *
 * Invariants:
 * - `load()` may be synchronous or async.
 * - `save()` may be synchronous or async.
 * - `watch()` is optional; stores that can observe external changes may report
 *   inbound updates, including echoes of local writes.
 */
export type MaybePromise<T> = T | Promise<T>;

export type SessionStorage = {
	load(): MaybePromise<AuthSession | null>;
	save(value: AuthSession | null): MaybePromise<void>;
	watch?(fn: (next: AuthSession | null) => void): () => void;
};
