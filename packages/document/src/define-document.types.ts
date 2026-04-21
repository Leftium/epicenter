/**
 * Public types for the `defineDocument` primitive.
 *
 * Kept in their own file so the primitive's public surface isn't mixed in
 * with the broader attach-ecosystem types in `./types.ts`.
 */

/**
 * A managed, retaining document handle. Returned by `factory.open(id)`. Each
 * call returns a distinct disposable wrapper over the same underlying
 * `ydoc`/attachments — N opens require N releases.
 *
 * Pair every `open()` with a `release()`:
 *
 * ```ts
 * // Manual
 * const h = docs.open('abc');
 * await h.whenLoaded;
 * h.release();
 *
 * // Framework-scoped
 * $effect(() => {
 *   const h = docs.open(id);
 *   return () => h.release();
 * });
 *
 * // TS 5.2 `using` — release fires on block exit
 * { using h = docs.open('abc'); await h.whenLoaded; }
 * ```
 *
 * Reserved top-level keys on the user's build-closure return value: `release`,
 * `whenLoaded`. The framework attaches those — if the build closure returns
 * one, `defineDocument` throws.
 */
export type DocumentHandle<TAttach> = TAttach &
	Disposable &
	AsyncDisposable & {
		/**
		 * Resolves once every attachment's own `whenLoaded` promise has resolved.
		 * Attachments without one count as "loaded immediately."
		 */
		whenLoaded: Promise<void>;
		/**
		 * Release this handle's retain. Idempotent per-wrapper — calling twice
		 * on the same handle is a no-op. Last release (across all wrappers
		 * sharing the same id) schedules disposal after the factory's `graceMs`.
		 */
		release(): void;
	};

/**
 * Factory created by `defineDocument(build, opts?)`. Exposes cached,
 * ref-counted handles by id and coordinated teardown.
 */
export type DocumentFactory<Id extends string, TAttach> = {
	/**
	 * Construct-if-missing + retain. Returns a fresh disposable handle. Pair
	 * with `handle.release()`. For callers that need to wait for hydration,
	 * `await handle.whenLoaded` after opening.
	 *
	 * ```ts
	 * const h = factory.open('abc');
	 * await h.whenLoaded;
	 * h.content.write('hi');
	 * h.release();
	 * ```
	 */
	open(id: Id): DocumentHandle<TAttach>;
	/**
	 * Explicit eviction. Cancels any pending grace-period disposal. `ydoc.destroy()`
	 * fires synchronously; the returned promise resolves once every top-level
	 * attachment's `disposed: Promise<void>` field has resolved (if any).
	 */
	close(id: Id): Promise<void>;
	/**
	 * Tear down every open document — for app teardown / workspace dispose.
	 * Destroys all ydocs synchronously; awaits every attachment's `disposed`
	 * promise before resolving.
	 */
	closeAll(): Promise<void>;
};
