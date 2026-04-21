/**
 * Public types for the `defineDocument` primitive.
 *
 * Kept in their own file so the primitive's public surface isn't mixed in
 * with the broader attach-ecosystem types in `./types.ts`.
 */

/**
 * A reference-counted document handle. Returned by `factory.open(id)`. Each
 * call returns a distinct disposable handle over the same underlying bundle
 * (the user's `build(id)` return value — `{ ydoc, ...attachments }`). N opens
 * require N disposes.
 *
 * The handle is created via `Object.create(bundle)` — all bundle properties
 * (including `whenDisposed` and user conventions like `whenReady`) are
 * accessible through the prototype chain. Only the two dispose methods below
 * are injected by the cache.
 *
 * Pair every `open()` with a `dispose()`:
 *
 * ```ts
 * // Manual
 * const h = docs.open('abc');
 * await h.whenReady;  // user-owned convention on the bundle
 * h.dispose();
 *
 * // Framework-scoped
 * $effect(() => {
 *   const h = docs.open(id);
 *   return () => h.dispose();
 * });
 *
 * // TS 5.2 `using` — dispose fires on block exit
 * { using h = docs.open('abc'); await h.whenReady; }
 * ```
 *
 * `dispose()` is always synchronous — it just decrements the refcount. Async
 * teardown (awaiting `whenDisposed`) is a factory-level concern: use
 * `factory.close(id)` or `factory.closeAll()` when you need a real teardown
 * barrier.
 *
 * No top-level keys are reserved on the bundle. The cache injects only
 * `dispose` and `[Symbol.dispose]` on the handle — pick bundle property names
 * that don't collide with those two.
 */
export type DocumentHandle<T> = T & {
	/**
	 * Decrement this handle's refcount. Idempotent per-handle — calling twice
	 * on the same handle is a no-op. Last dispose (across all handles sharing
	 * the same id) schedules teardown after the factory's `gcTime`.
	 * Equivalent to `handle[Symbol.dispose]()` — use `using` blocks when
	 * scope-bound release suffices. For an async teardown barrier, use
	 * `factory.close(id)` instead.
	 */
	dispose(): void;
	[Symbol.dispose](): void;
};

/**
 * Factory created by `defineDocument(build, opts?)`. Exposes cached,
 * ref-counted handles by id and coordinated teardown.
 *
 * The builder fully owns bundle construction and disposal. The cache owns
 * identity (keyed by `id`, verified by `ydoc.guid`), refcount, and the
 * `gcTime` grace period between last-dispose and actual teardown.
 */
export type DocumentFactory<Id extends string, T> = {
	/**
	 * Construct-if-missing + refcount++. Returns a fresh disposable handle that
	 * prototype-chains to the underlying bundle. Pair with `handle.dispose()`.
	 *
	 * If the builder exposes a `whenReady` promise on the bundle, callers may
	 * `await handle.whenReady` after opening — but the name is a user-owned
	 * convention, not a framework-enforced key.
	 *
	 * ```ts
	 * const h = factory.open('abc');
	 * await h.whenReady;
	 * h.content.write('hi');
	 * h.dispose();
	 * ```
	 */
	open(id: Id): DocumentHandle<T>;
	/**
	 * Explicit eviction. Cancels any pending `gcTime` disposal and fires the
	 * bundle's `[Symbol.dispose]()` synchronously. If the bundle exposes a
	 * `whenDisposed: Promise<void>` property, the returned promise resolves
	 * once it settles — giving callers a real teardown barrier.
	 *
	 * Force-closes even if handles are outstanding; those handles become
	 * unusable (the underlying Y.Doc is destroyed). Prefer letting refcount→0
	 * drive disposal in steady-state code.
	 */
	close(id: Id): Promise<void>;
	/**
	 * Tear down every open document — for app teardown / workspace dispose.
	 * Disposes all bundles synchronously; awaits every bundle's optional
	 * `whenDisposed` promise before resolving. Same outstanding-handle caveat
	 * as `close(id)`.
	 */
	closeAll(): Promise<void>;
};
