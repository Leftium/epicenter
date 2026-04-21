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
 * using h = docs.open('abc');  // openCount++
 * await h.whenReady;           // read through prototype chain to bundle
 * h.ydoc.transact(() => ..., ORIGIN);
 * // [Symbol.dispose] fires on block exit — openCount--
 * // refcount→0 arms the gcTime timer; a fresh open() cancels it
 * ```
 *
 * ## Builder contract
 *
 * The builder returns a bundle typed `T extends { ydoc: Y.Doc } & Disposable`:
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
 * `whenReady` and `whenDisposed` are user-owned conventions, not
 * framework-enforced keys. The cache never scans the bundle for them. `open()`
 * doesn't read `whenReady`; callers `await handle.whenReady` through the
 * prototype chain if the builder exposed one. `close(id)` awaits
 * `bundle.whenDisposed` if present (detected via `in`), giving callers a real
 * teardown barrier. `whenReady` deliberately differs from Y.Doc's native
 * `whenLoaded` property — avoid the shadow collision.
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
 * - **`gcTime: Infinity`** — never evict automatically; only `close(id)` or
 *   `closeAll()` can force teardown.
 * - **Default**: `30_000` ms. A fresh `open()` during the grace window cancels
 *   the pending teardown.
 *
 * @module
 */

import type * as Y from 'yjs';
import type {
	DocumentFactory,
	DocumentHandle,
} from './define-document.types.js';

const DEFAULT_GC_TIME = 30_000;

type DocEntry<T extends { ydoc: Y.Doc } & Disposable> = {
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
 * @param opts  - `gcTime` (default 30_000): milliseconds to wait after the
 *                last handle dispose before tearing down the bundle. `0` =
 *                synchronous teardown. `Infinity` = never auto-evict. A fresh
 *                open during the grace window cancels the pending teardown.
 */
export function defineDocument<
	Id extends string,
	T extends { ydoc: Y.Doc } & Disposable,
>(
	build: (id: Id) => T,
	opts?: { gcTime?: number },
): DocumentFactory<Id, T> {
	const gcTime = opts?.gcTime ?? DEFAULT_GC_TIME;
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

			const handle = Object.create(entry.bundle) as DocumentHandle<T>;
			Object.defineProperties(handle, {
				dispose: { value: dispose },
				[Symbol.dispose]: { value: dispose },
			});
			return handle;
		},

		async close(id) {
			const entry = openDocuments.get(id);
			if (!entry) return;
			disposeEntry(id, entry);
			if ('whenDisposed' in entry.bundle) {
				await (entry.bundle as { whenDisposed?: Promise<void> }).whenDisposed;
			}
		},

		async closeAll() {
			const entries = Array.from(openDocuments.entries());
			openDocuments.clear();
			for (const [id, entry] of entries) disposeEntry(id, entry);
			await Promise.all(
				entries.map(([, entry]) => {
					if ('whenDisposed' in entry.bundle) {
						return (entry.bundle as { whenDisposed?: Promise<void> })
							.whenDisposed;
					}
					return undefined;
				}),
			);
		},
	};

	return factory;
}
