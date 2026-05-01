import type { Session } from './auth-types.ts';

/**
 * Persistence boundary that `createAuth` uses to load, save, and observe the
 * browser session. Core auth owns the in-memory snapshot; storage only moves
 * data across the durable boundary.
 *
 * Invariants:
 * - `load()` may be synchronous or async.
 * - `save()` may be synchronous or async.
 * - `watch()` reports inbound storage changes and may echo local writes.
 */
export type MaybePromise<T> = T | Promise<T>;

export type SessionStorage = {
	load(): MaybePromise<Session | null>;
	save(value: Session | null): MaybePromise<void>;
	watch(fn: (next: Session | null) => void): () => void;
};
