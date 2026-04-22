/**
 * `defineDocument` — a minimal refcounted cache for Y.Doc bundles.
 *
 * The user owns construction and disposal. The cache owns identity, refcount,
 * and the `gcTime` grace period between last-dispose and actual teardown.
 *
 * ```text
 *  builder (user)                     cache (this module)
 *  ─────────────────                  ───────────────────
 *  new Y.Doc + providers              keyed by id, verified by ydoc.guid
 *  composes whenReady / whenDisposed  refcounts open/dispose
 *  implements [Symbol.dispose]        arms gcTime timer on last dispose
 * ```
 *
 * ## Three usage levels
 *
 * ### Level 0 — plain builder, no cache
 *
 * ```ts
 * const doc = buildDoc('x');
 * doc.ydoc.transact(() => ..., ORIGIN);
 * doc[Symbol.dispose]();
 * ```
 *
 * ### Level 1 — scope-bound with TS 5.2 `using`
 *
 * ```ts
 * {
 *   using doc = buildDoc('x');
 *   await doc.whenReady;
 *   doc.ydoc.transact(() => ..., ORIGIN);
 * } // [Symbol.dispose] fires on block exit
 * ```
 *
 * ### Level 2 — shared + lifecycle via `defineDocument`
 *
 * ```ts
 * const docs = defineDocument(buildDoc, { gcTime: 30_000 });
 *
 * // Imperative callers that need loaded data: use `load()`.
 * await using h = await docs.load('abc');
 * h.ydoc.transact(() => ..., ORIGIN);
 *
 * // Reactive callers that want the handle immediately: use `open()`.
 * using h = docs.open('abc');          // openCount++
 * // subscribe to reactive state now; await h.whenReady in a $effect
 * // [Symbol.dispose] fires on block exit — openCount--
 * // refcount→0 arms the gcTime timer; a fresh open() cancels it
 * ```
 *
 * ## Builder contract
 *
 * The builder returns a bundle typed
 * `T extends { ydoc: Y.Doc; whenDisposed?: Promise<void> } & Disposable`:
 *
 * ```ts
 * function buildDoc(id: string) {
 *   const ydoc = new Y.Doc({ guid: id });
 *   const idb  = attachIndexedDb(ydoc);
 *   const sync = attachSync(ydoc, { url });
 *
 *   return {
 *     ydoc,
 *     idb,
 *     sync,
 *     whenReady:    Promise.all([idb.whenLoaded, sync.whenSynced]).then(() => {}),
 *     whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed]).then(() => {}),
 *     [Symbol.dispose]() { ydoc.destroy(); },
 *   };
 * }
 * ```
 *
 * `whenReady` is required — `factory.load(id)` awaits it to hand back a
 * loaded handle. Sync-ready bundles set `whenReady: Promise.resolve()`
 * explicitly so every bundle declares its readiness model. `whenReady`
 * deliberately differs from Y.Doc's native `whenLoaded` property — avoid
 * the shadow collision.
 *
 * `whenDisposed` is optional: `close(id)` and `closeAll()` await it to give
 * callers a real teardown barrier. Bundles with synchronous teardown can
 * omit it.
 *
 * ## Two layers of `when*` barriers
 *
 * Attachments and bundles both expose `when*` promises, but they play
 * different roles. Names aren't interchangeable — each describes a distinct
 * real event.
 *
 * ```text
 *  ATTACHMENT LAYER (for builders — descriptive event names)
 *  ────────────────────────────────────────────────────────
 *  idb.whenLoaded      — local storage replayed into the Y.Doc
 *  sync.whenConnected  — WebSocket up + first remote exchange done
 *  idb.whenDisposed    — this provider's teardown settled
 *  sync.whenDisposed   — ditto, per provider
 *                        ↓  Promise.all(...)
 *  BUNDLE LAYER (for consumers — semantic aggregates)
 *  ────────────────────────────────────────────────────────
 *  bundle.whenReady     — whatever "ready" means for this doc type
 *                         (local-only apps: idb.whenLoaded;
 *                          collab apps: both; read-only: sync only)
 *  bundle.whenDisposed  — every provider's teardown settled
 *                         (awaited by factory.close / closeAll)
 * ```
 *
 * Rule of thumb: consumers of a `handle` only await bundle-layer barriers
 * (`whenReady`, and indirectly `whenDisposed` via `close()`). Attachment-layer
 * names exist so builders can compose precisely — don't leak them to handle
 * consumers unless you have a specific reason.
 *
 * ## Provider teardown
 *
 * Attachments like `attachIndexedDb` and `attachSync` register
 * `ydoc.once('destroy')` internally, so `ydoc.destroy()` in your
 * `[Symbol.dispose]` cascades teardown to every provider. Each provider's
 * `whenDisposed` promise resolves only after its real cleanup completes
 * (IDB awaits `db.close()`; sync awaits the supervisor's exit and the
 * WebSocket's `onclose`, with a 1 s fallback for stalled close handshakes).
 * Aggregate them into your bundle's `whenDisposed` for a real teardown
 * barrier.
 *
 * ## Cache semantics
 *
 * - **Identity**: keyed by `id`; `ydoc.guid` is recorded on first construction
 *   and verified on every subsequent one (catches nondeterministic builders).
 * - **Refcount**: each `open()` mints a fresh disposable handle and
 *   increments. `handle.dispose()` is idempotent per-handle. Last dispose
 *   across all handles for an id arms the gcTime timer.
 * - **`gcTime: 0`** — synchronous teardown on refcount→0, no timer.
 * - **`gcTime: Infinity`** (default) — never evict automatically; only
 *   `close(id)` or `closeAll()` can force teardown.
 * - **Finite `gcTime`** — arm a timer on refcount→0; a fresh `open()` during
 *   the grace window cancels the pending teardown.
 *
 * Why `Infinity` is the default: a Y.Doc bundle isn't a query result — it's a
 * handle to live, synced state. Re-opening costs a full IDB reload + websocket
 * reconnect + resync handshake, and during the gap remote updates are missed.
 * Explicit `close(id)` is the right teardown signal for docs; idle timeout is
 * opt-in for high-churn cases.
 *
 * ## Force close semantics
 *
 * `close(id)` and `closeAll()` tear down the bundle **even if handles are
 * still outstanding**. Those outstanding handles become unusable — reads
 * through the prototype chain still reach the bundle, but operations like
 * `h.ydoc.transact(...)` will hit Y.Doc's "destroyed doc" behavior. Force
 * close is for caller-initiated teardown (logout, workspace unmount, app
 * shutdown); in steady-state use, let refcount→0 drive disposal instead.
 *
 * @module
 */

import type * as Y from 'yjs';

/**
 * The contract every `defineDocument` builder must satisfy.
 *
 * Formalizes the implicit shape `defineDocument` has always required:
 *
 * - `ydoc: Y.Doc` — the underlying CRDT document the cache identifies the
 *   bundle by (guid verified across re-constructions).
 * - `[Symbol.dispose]()` — synchronous teardown; called by `close(id)` /
 *   `closeAll()` and by refcount→0 after `gcTime` elapses.
 * - `whenReady: Promise<void>` — resolves when the bundle is usable (e.g.
 *   `Promise.all([idb.whenLoaded, sync.whenConnected])`). Sync-ready bundles
 *   use `Promise.resolve()`. `factory.load(id)` awaits this before returning
 *   a loaded handle.
 * - `whenDisposed?: Promise<void>` — async teardown barrier the cache awaits
 *   inside `close(id)` / `closeAll()`. Omit for synchronous-only bundles.
 *
 * This is the vocabulary-tier shape for documents, same stratum as `Table`,
 * `Kv`, and `Awareness`. Exported for authors writing custom builders or
 * typing bundles outside a `defineDocument` call.
 */
export type DocumentBundle = {
	ydoc: Y.Doc;
	[Symbol.dispose](): void;
	whenReady: Promise<void>;
	whenDisposed?: Promise<void>;
};

/**
 * Brand symbol for handles returned by `defineDocument(...).open(id)`.
 * Module-private; use `isDocumentHandle(value)` to check.
 */
const DOCUMENT_HANDLE: unique symbol = Symbol.for('epicenter.document.handle');

/**
 * A reference-counted document handle. Returned by `factory.open(id)`. Each
 * call returns a distinct disposable handle — a shallow copy of the bundle's
 * own enumerable properties, plus `dispose`, `[Symbol.dispose]`, and a
 * `[DOCUMENT_HANDLE]` brand. N opens require N disposes.
 *
 * Pair every `open()` with a `dispose()`. Two idiomatic patterns:
 *
 * ```ts
 * // Imperative — `load()` awaits whenReady; `await using` scopes disposal.
 * await using h = await docs.load('abc');
 * h.content.write('hi');
 * // dispose fires on block exit
 *
 * // Reactive — `open()` returns the handle before readiness so reactive
 * // code can subscribe; manual dispose on unmount.
 * $effect(() => {
 *   const h = docs.open(id);
 *   return () => h.dispose();
 * });
 * ```
 *
 * `dispose()` is always synchronous — it just decrements the refcount. Async
 * teardown (awaiting `whenDisposed`) is a factory-level concern: use
 * `factory.close(id)` or `factory.closeAll()` when you need a real teardown
 * barrier.
 *
 * Reserved keys on the bundle: `dispose`, `[Symbol.dispose]`, and
 * `[DOCUMENT_HANDLE]`. Pick bundle property names that don't collide.
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
	/** Brand marker — identifies handles minted by `defineDocument.open()`. */
	[DOCUMENT_HANDLE]: true;
};

/**
 * Type guard: `true` iff `value` was minted by `defineDocument(...).open(id)`.
 * Checks a `Symbol.for`-branded marker — survives module duplication.
 */
export function isDocumentHandle(
	value: unknown,
): value is DocumentHandle<DocumentBundle> {
	return (
		typeof value === 'object' &&
		value !== null &&
		DOCUMENT_HANDLE in value
	);
}

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
	 * Returns immediately without waiting for any async readiness. If the
	 * builder exposes a `whenReady` promise, the returned handle may not yet
	 * reflect persisted state — reads can observe empty content until load
	 * completes. Use this path when you want reactive access before readiness
	 * (e.g., UI components subscribing and rendering a loading state).
	 *
	 * For imperative read/write code that needs loaded data, prefer
	 * {@link DocumentFactory.load} — it awaits `whenReady` for you and makes
	 * the forgotten-await footgun uncallable.
	 *
	 * ```ts
	 * // Reactive: want the handle immediately, observe readiness separately.
	 * using h = factory.open('abc');
	 * $effect(() => { h.whenReady?.then(() => ...); });
	 * ```
	 */
	open(id: Id): DocumentHandle<T>;
	/**
	 * Open + await `bundle.whenReady`. Returns a handle guaranteed to reflect
	 * persisted state (or whatever "ready" means for the bundle). Refcount is
	 * incremented before awaiting; if `whenReady` rejects, the handle is
	 * disposed and the rejection propagates.
	 *
	 * Use this from imperative call sites where you want loaded data without
	 * the two-step `open(); await handle.whenReady` dance. Pairs naturally with
	 * `await using` for scope-bound release.
	 *
	 * ```ts
	 * await using h = await factory.load('abc');
	 * h.content.write('hi');
	 * // dispose fires on block exit
	 * ```
	 *
	 * Hazard: if a concurrent `close(id)` / `closeAll()` fires while
	 * `whenReady` is in flight, the returned handle wraps a destroyed Y.Doc
	 * — subsequent operations will throw. Same hazard applies to manual
	 * `open() + await whenReady`, but worth naming: caller-initiated
	 * teardown during an in-flight load is a logic error higher up.
	 */
	load(id: Id): Promise<DocumentHandle<T>>;
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

type DocEntry<T extends DocumentBundle> = {
	/** The user's pristine `build()` return value. Never mutated. */
	bundle: T;
	openCount: number;
	gcTimer: ReturnType<typeof setTimeout> | null;
	disposed: boolean;
};

/**
 * Create a document factory from a user-owned build closure.
 *
 * @param build - Closure invoked on cache miss. Must return a bundle
 *                `{ ydoc, ... } & Disposable` — i.e., an object with a
 *                `ydoc: Y.Doc` and a `[Symbol.dispose]()` method. `ydoc.guid`
 *                should be a deterministic function of `id` — the cache
 *                asserts stability on the second construction.
 * @param opts  - `gcTime` (default `Infinity`): milliseconds to wait after the
 *                last handle dispose before tearing down the bundle. `0` =
 *                synchronous teardown. `Infinity` = never auto-evict (the
 *                default — see module doc for rationale). A fresh open during
 *                the grace window cancels the pending teardown.
 */
export function defineDocument<
	Id extends string,
	T extends DocumentBundle,
>(
	build: (id: Id) => T,
	{ gcTime = Number.POSITIVE_INFINITY }: { gcTime?: number } = {},
): DocumentFactory<Id, T> {
	const openDocuments = new Map<Id, DocEntry<T>>();
	const recordedGuids = new Map<Id, string>();

	function construct(id: Id): DocEntry<T> {
		// User closure runs synchronously. If it throws, we DON'T insert into
		// the cache — next `.open(sameId)` re-runs the closure (no poisoned
		// cache entry). The caller sees the thrown error.
		const bundle = build(id);

		const recorded = recordedGuids.get(id);
		if (recorded !== undefined && recorded !== bundle.ydoc.guid) {
			// Don't leak the half-built bundle — dispose before throwing so the
			// user's own `[Symbol.dispose]` can clean up its providers.
			try {
				bundle[Symbol.dispose]();
			} catch {
				// best-effort — surface the stability error, not the dispose error
			}
			throw new Error(
				`[defineDocument] guid instability for id=${String(id)}: ` +
					`expected ${recorded}, got ${bundle.ydoc.guid}. ` +
					`Ensure your build closure produces a deterministic guid.`,
			);
		}
		if (recorded === undefined) {
			recordedGuids.set(id, bundle.ydoc.guid);
		}

		const entry: DocEntry<T> = {
			bundle,
			openCount: 0,
			gcTimer: null,
			disposed: false,
		};

		openDocuments.set(id, entry);
		return entry;
	}

	function disposeEntry(id: Id, entry: DocEntry<T>): void {
		entry.disposed = true;
		if (entry.gcTimer !== null) {
			clearTimeout(entry.gcTimer);
			entry.gcTimer = null;
		}
		// Remove from cache synchronously so a concurrent `.open()` constructs
		// a fresh entry rather than handing out the about-to-be-destroyed one.
		// `closeAll` pre-clears the map; this guard makes that path a no-op.
		if (openDocuments.get(id) === entry) {
			openDocuments.delete(id);
		}
		// Builder owns what disposal means. Any async teardown settles in the
		// background; callers awaiting a full teardown barrier do so via
		// `close(id)`, which awaits `bundle.whenDisposed` if present.
		try {
			entry.bundle[Symbol.dispose]();
		} catch (err) {
			console.error('[defineDocument] bundle [Symbol.dispose]() threw:', err);
		}
	}

	const factory: DocumentFactory<Id, T> = {
		open(id) {
			// Each open() mints a fresh disposable handle with its own
			// `disposed` flag, so N opens require N disposes before the gc
			// timer starts. The handle prototype-chains to `entry.bundle` — so
			// `h.ydoc` and any user bundle properties read through without
			// mutating the user's object.
			const entry = openDocuments.get(id) ?? construct(id);

			if (entry.gcTimer !== null) {
				clearTimeout(entry.gcTimer);
				entry.gcTimer = null;
			}
			entry.openCount++;

			let handleDisposed = false;
			const dispose = (): void => {
				if (handleDisposed) return;
				handleDisposed = true;
				if (entry.disposed) return;
				entry.openCount--;
				if (entry.openCount !== 0) return;

				if (gcTime === 0) {
					// Synchronous teardown — no timer.
					disposeEntry(id, entry);
					return;
				}
				if (gcTime === Infinity) {
					// Never auto-evict; entry stays live until close(id)/closeAll().
					return;
				}
				entry.gcTimer = setTimeout(() => {
					entry.gcTimer = null;
					disposeEntry(id, entry);
				}, gcTime);
			};

			return {
				...entry.bundle,
				dispose,
				[Symbol.dispose]: dispose,
				[DOCUMENT_HANDLE]: true,
			};
		},

		async load(id) {
			const handle = factory.open(id);
			try {
				await handle.whenReady;
				return handle;
			} catch (err) {
				handle.dispose();
				throw err;
			}
		},

		async close(id) {
			const entry = openDocuments.get(id);
			if (!entry) return;
			disposeEntry(id, entry);
			await entry.bundle.whenDisposed;
		},

		async closeAll() {
			const entries = Array.from(openDocuments.entries());
			openDocuments.clear();
			for (const [id, entry] of entries) disposeEntry(id, entry);
			await Promise.all(entries.map(([, entry]) => entry.bundle.whenDisposed));
		},
	};

	return factory;
}
