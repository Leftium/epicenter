/**
 * Public types for the `defineDocument` primitive.
 *
 * Kept in their own file so the primitive's public surface isn't mixed in
 * with the broader attach-ecosystem types in `./types.ts`.
 */

/**
 * A managed document handle returned by `factory.get(id)`.
 *
 * The user's attachments are flattened onto the handle alongside framework
 * extras (`whenLoaded`, `retain`). `handle.content.binding` reads better than
 * `handle.attachments.content.binding`.
 *
 * Reserved top-level keys: `retain` and `whenLoaded`. If the build closure
 * returns an object containing either, `defineDocument` throws — pick a
 * different attachment name.
 */
export type DocumentHandle<TAttach> = TAttach & {
	/**
	 * Resolves once every attachment's own `whenLoaded` promise has resolved.
	 * Attachments without one count as "loaded immediately."
	 */
	whenLoaded: Promise<void>;
	/**
	 * Ref-counted retention. Returns an idempotent release closure.
	 * Last release schedules disposal after the factory's `graceMs`; a fresh
	 * retain during the grace window cancels the pending disposal.
	 *
	 * Named `retain` rather than `bind` to avoid collision with
	 * `Function.prototype.bind` at call sites (`handle.bind()` reads like a
	 * `this` bind).
	 */
	retain(): () => void;
};

/**
 * Factory created by `defineDocument(build, opts?)`. Exposes cached,
 * ref-counted handles by id and coordinated teardown.
 */
export type DocumentFactory<Id extends string, TAttach> = {
	/** Cached, ref-counted handle. Concurrent `.get(sameId)` returns the same instance. */
	get(id: Id): DocumentHandle<TAttach>;
	/** Sugar: `.get(id)` + `await handle.whenLoaded`, returns the handle. */
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
