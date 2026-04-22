/**
 * `createDocumentFactory` — a minimal refcounted cache for Y.Doc bundles.
 *
 * The user owns construction and disposal. The cache owns identity, refcount,
 * and the `gcTime` grace period between last-dispose and actual teardown.
 * Readiness **and** disposal-barriers are attachment-level conventions, not
 * framework concerns — bundles expose them (or don't) as they see fit, and
 * consumers await whichever gate fits at the call site.
 *
 * ```text
 *  builder (user)                     cache (this module)
 *  ─────────────────                  ───────────────────
 *  new Y.Doc + providers              keyed by id, verified by ydoc.guid
 *  owns readiness/teardown promises   refcounts open/dispose
 *  implements [Symbol.dispose] (sync) arms gcTime timer on last dispose
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
 *   await doc.whenReady;  // if the builder exposes one by convention
 *   doc.ydoc.transact(() => ..., ORIGIN);
 * } // [Symbol.dispose] fires on block exit
 * ```
 *
 * ### Level 2 — shared + lifecycle via `createDocumentFactory`
 *
 * ```ts
 * const docs = createDocumentFactory(buildDoc, { gcTime: 30_000 });
 *
 * // Imperative caller that needs loaded data — open, then await the
 * // builder-conventional readiness gate at the call site.
 * using h = docs.open('abc');
 * await h.whenReady;                   // builder convention, not framework
 * h.ydoc.transact(() => ..., ORIGIN);
 *
 * // Reactive caller that wants the handle immediately: same `open()`, no
 * // await. Subscribe to reactive state now; await readiness in a `$effect`
 * // if the UI needs it.
 * using h = docs.open('abc');          // openCount++
 * // [Symbol.dispose] fires on block exit — openCount--
 * // refcount→0 arms the gcTime timer; a fresh open() cancels it
 *
 * // Rare teardown barrier: opt into a specific attachment's field.
 * docs.close('abc');
 * await h.idb.whenDisposed;            // attachment-level, if you need it
 * ```
 *
 * ## Builder contract
 *
 * The builder returns a bundle typed
 * `T extends { ydoc: Y.Doc } & Disposable` — i.e., any object with a
 * `ydoc: Y.Doc` and a synchronous `[Symbol.dispose]()`. Anything else
 * (readiness promises, attachment handles, materializer interfaces) is at
 * the builder's discretion and flows through the handle verbatim:
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
 *     // `whenReady` is a builder convention — expose one if it helps
 *     // consumers; the framework doesn't consume or require it.
 *     whenReady: Promise.all([idb.whenLoaded, sync.whenSynced]).then(() => {}),
 *     [Symbol.dispose]() { ydoc.destroy(); },
 *   };
 * }
 * ```
 *
 * ## Attachment-level `when*` barriers
 *
 * Attachments expose descriptive `when*` promises that consumers can await
 * directly. The framework does not aggregate or orchestrate these — each
 * consumer awaits whichever barrier fits the call site.
 *
 * ```text
 *  idb.whenLoaded      — local storage replayed into the Y.Doc
 *  sync.whenConnected  — WebSocket up + first remote exchange done
 *  idb.whenDisposed    — this provider's teardown settled
 *  sync.whenDisposed   — ditto, per provider
 * ```
 *
 * Builders may aggregate these into a bundle-level `whenReady` as a
 * convention (see Builder contract above). That name is load-bearing for
 * grep-ability and review, but it's a convention — not a contract the
 * framework enforces.
 *
 * ## Provider teardown
 *
 * `[Symbol.dispose]()` is **synchronous** — it calls `ydoc.destroy()` and
 * returns. Attachments like `attachIndexedDb` and `attachSync` self-wire
 * via `ydoc.on('destroy')` internally, and their real async cleanup (IDB
 * `db.close()`, WebSocket onclose, etc.) runs in the background after
 * dispose returns. Idempotency is free: `Y.Doc` sets `isDestroyed` on first
 * destroy and noops on subsequent calls; attachments use a `disposed` flag.
 *
 * `factory.close(id)` and `factory.closeAll()` trigger this cascade and
 * return `void` — they do **not** wait for async cleanup to settle. Callers
 * that need a real teardown barrier (tests that close-then-reopen the same
 * id, CLI flows that exit the process) opt in at the specific call site
 * by awaiting an attachment-level field:
 *
 * ```ts
 * docs.close(id);
 * await h.idb.whenDisposed;     // explicit, not magic
 * ```
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

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type * as Y from 'yjs';

/** Errors surfaced by the document factory's background disposal machinery. */
export const DocumentFactoryError = defineErrors({
	/**
	 * The user-supplied bundle's `[Symbol.dispose]` raised. We've already
	 * removed the bundle from the cache; the throw is informational — we
	 * still want the underlying Y.Doc and any open refcounts torn down.
	 */
	BundleDisposeThrew: ({ cause }: { cause: unknown }) => ({
		message: `[createDocumentFactory] bundle [Symbol.dispose]() threw: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type DocumentFactoryError = InferErrors<typeof DocumentFactoryError>;

/**
 * The contract every `createDocumentFactory` builder must satisfy.
 *
 * - `ydoc: Y.Doc` — the underlying CRDT document the cache identifies the
 *   bundle by (guid verified across re-constructions).
 * - `[Symbol.dispose]()` — **synchronous** teardown; called by `close(id)` /
 *   `closeAll()` and by refcount→0 after `gcTime` elapses. Typically just
 *   `ydoc.destroy()`; attachments self-wire via `ydoc.on('destroy')` and run
 *   their async cleanup in the background.
 *
 * Readiness and teardown barriers are **not** part of this contract — if a
 * builder exposes them (e.g. `whenReady`, `whenDisposed`, `idb.whenLoaded`)
 * that's a builder-level convention consumers can await at the call site.
 * The framework neither reads nor requires them.
 *
 * This is the vocabulary-tier shape for documents, same stratum as `Table`,
 * `Kv`, and `Awareness`. Exported for authors writing custom builders or
 * typing bundles outside a `createDocumentFactory` call.
 */
export type DocumentBundle = {
	ydoc: Y.Doc;
	[Symbol.dispose](): void;
};

/**
 * Brand symbol for handles returned by `createDocumentFactory(...).open(id)`.
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
 * // Imperative — open, await builder-conventional readiness, use `using`
 * // for scope-bound disposal.
 * using h = docs.open('abc');
 * await h.whenReady;           // builder convention; omit if not exposed
 * h.content.write('hi');
 * // dispose fires on block exit
 *
 * // Reactive — `open()` returns the handle immediately so reactive code
 * // can subscribe before readiness; manual dispose on unmount.
 * $effect(() => {
 *   const h = docs.open(id);
 *   return () => h.dispose();
 * });
 * ```
 *
 * `dispose()` is always synchronous — it just decrements the refcount. If a
 * caller needs a real teardown barrier (rare — tests close-then-reopen, CLI
 * process exit), it opts into a specific attachment-level field at the call
 * site: `docs.close(id); await h.idb.whenDisposed;`.
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
	 * scope-bound release suffices. For explicit eviction regardless of
	 * outstanding handles, use `factory.close(id)` instead.
	 */
	dispose(): void;
	[Symbol.dispose](): void;
	/** Brand marker — identifies handles minted by `createDocumentFactory.open()`. */
	[DOCUMENT_HANDLE]: true;
};

/**
 * Type guard: `true` iff `value` was minted by `createDocumentFactory(...).open(id)`.
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
 * Factory created by `createDocumentFactory(build, opts?)`. Exposes cached,
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
	 * builder exposes a readiness promise by convention (e.g. `whenReady`),
	 * the returned handle may not yet reflect persisted state — reads can
	 * observe empty content until load completes. Consumers choose whether
	 * to await it:
	 *
	 * ```ts
	 * // Imperative: await the builder's readiness convention before reading.
	 * using h = factory.open('abc');
	 * await h.whenReady;
	 * h.content.write('hi');
	 *
	 * // Reactive: subscribe immediately, observe readiness in an effect.
	 * using h = factory.open('abc');
	 * $effect(() => { h.whenReady?.then(() => ...); });
	 * ```
	 */
	open(id: Id): DocumentHandle<T>;
	/**
	 * Explicit eviction. Cancels any pending `gcTime` disposal and fires the
	 * bundle's `[Symbol.dispose]()` synchronously, then returns. Async cleanup
	 * inside attachments (IDB `db.close()`, WebSocket onclose, etc.) runs in
	 * the background via each attachment's `ydoc.on('destroy')` handler.
	 *
	 * Force-closes even if handles are outstanding; those handles become
	 * unusable (the underlying Y.Doc is destroyed). Prefer letting refcount→0
	 * drive disposal in steady-state code.
	 *
	 * Does **not** wait for attachment teardown to settle. If a caller needs
	 * a teardown barrier (close-then-reopen in tests, process exit in CLI),
	 * it awaits a specific attachment-level field at the call site:
	 * `docs.close(id); await h.idb.whenDisposed;`.
	 */
	close(id: Id): void;
	/**
	 * Tear down every open document — for app teardown / workspace dispose.
	 * Disposes all bundles synchronously and returns. Same fire-and-forget
	 * async-cleanup semantics as `close(id)`, and same outstanding-handle
	 * caveat. Callers needing a flush barrier before exit await the relevant
	 * attachment-level field per handle before calling this.
	 */
	closeAll(): void;
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
export function createDocumentFactory<
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
				`[createDocumentFactory] guid instability for id=${String(id)}: ` +
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
		// Builder owns what disposal means. `[Symbol.dispose]` is synchronous;
		// any attachment-level async cleanup runs in the background via
		// `ydoc.on('destroy')` handlers. Callers that need a teardown barrier
		// opt into a specific attachment field at the call site.
		try {
			entry.bundle[Symbol.dispose]();
		} catch (err) {
			console.error('[createDocumentFactory] bundle [Symbol.dispose]() threw:', err);
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

		close(id) {
			const entry = openDocuments.get(id);
			if (!entry) return;
			disposeEntry(id, entry);
		},

		closeAll() {
			const entries = Array.from(openDocuments.entries());
			openDocuments.clear();
			for (const [id, entry] of entries) disposeEntry(id, entry);
		},
	};

	return factory;
}
