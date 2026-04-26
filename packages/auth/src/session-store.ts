import type { AuthSession } from './auth-types.ts';

/**
 * Synchronous store contract that `createAuth` uses to read and write the
 * persisted session. Core auth stays sync-only; async concerns (IndexedDB,
 * chrome.storage) are the adapter's job — adapters hydrate once at boot,
 * cache the value in memory, and expose a sync read.
 *
 * Invariants:
 * - All three methods are synchronous.
 * - `watch` fires for every state change, including local writes via `set()`.
 *   Stores that only fire on external change need an adapter that fans out
 *   local writes.
 * - `set()` is fire-and-forget. It may persist asynchronously, but the next
 *   `get()` returns the new value immediately.
 */
export type SessionStore = {
	get(): AuthSession | null;
	set(value: AuthSession | null): void;
	watch(fn: (next: AuthSession | null) => void): () => void;
};
