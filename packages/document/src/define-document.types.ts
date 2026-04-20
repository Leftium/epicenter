/**
 * Public types for the `defineDocument` primitive.
 *
 * Kept in their own file so the primitive's public surface isn't mixed in
 * with the broader attach-ecosystem types in `./types.ts`.
 */

/**
 * Non-retaining snapshot of a cached document. Returned by `factory.peek(id)`.
 *
 * Exposes the user's attachments and the aggregated `whenLoaded` promise, but
 * carries no `release` or `Symbol.dispose` — reading from a snapshot does not
 * keep the doc alive. If no one else retains it, the snapshot may reference a
 * doc on the grace-period path.
 */
export type DocumentSnapshot<TAttach> = TAttach & {
	/**
	 * Resolves once every attachment's own `whenLoaded` promise has resolved.
	 * Attachments without one count as "loaded immediately."
	 */
	whenLoaded: Promise<void>;
};

/**
 * A managed, retaining document handle. Returned by `factory.open(id)` and
 * `factory.read(id)`. Each call returns a distinct disposable wrapper over
 * the same underlying `ydoc`/attachments — N opens require N releases.
 *
 * Use with TS 5.2 `using` / `await using` for scope-bound retention:
 *
 * ```ts
 * using h = docs.open('abc');
 * h.content.write('hi');
 * // release fires on scope exit
 * ```
 *
 * Reserved top-level keys on the user's build-closure return value: `release`,
 * `whenLoaded`. The framework attaches those — if the build closure returns
 * one, `defineDocument` throws.
 */
export type DocumentHandle<TAttach> = DocumentSnapshot<TAttach> &
	Disposable &
	AsyncDisposable & {
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
	 * Construct-if-missing + retain. Returns a fresh disposable handle.
	 * Pair with `handle.release()` or bind to scope via `using`.
	 *
	 * ```ts
	 * using h = factory.open('abc');
	 * h.content.write('hi');
	 * ```
	 */
	open(id: Id): DocumentHandle<TAttach>;
	/**
	 * Non-retaining cache lookup. Returns a snapshot if the id is currently
	 * open, `undefined` otherwise. Does NOT construct. Does NOT increment
	 * the retain count. The snapshot has no `release` or `Symbol.dispose` —
	 * callers do not need to release it.
	 */
	peek(id: Id): DocumentSnapshot<TAttach> | undefined;
	/** `open(id)` + `await handle.whenLoaded`. Returns the retaining handle. */
	read(id: Id): Promise<DocumentHandle<TAttach>>;
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
