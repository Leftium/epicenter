import type { AuthSession } from './auth-types.ts';

/**
 * Persistence boundary that `createAuth` uses to load and save the last known
 * local session. Core auth owns the in-memory snapshot; storage only moves data
 * across the durable boundary.
 *
 * Invariants:
 * - `load()` may be synchronous or async.
 * - `save()` may be synchronous or async.
 */
export type MaybePromise<T> = T | Promise<T>;

export type SessionStorage = {
	load(): MaybePromise<AuthSession | null>;
	save(value: AuthSession | null): MaybePromise<void>;
};
