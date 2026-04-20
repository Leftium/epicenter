/**
 * `defineDocument` — the single primitive for constructing a managed Y.Doc.
 *
 * Accepts a user-owned `build(id) => { ydoc, ...attachments }` closure and
 * wraps it with a cache, ref-count + grace-period lifecycle, aggregated
 * `whenLoaded` readiness, and coordinated teardown.
 *
 * The primary idiom is `factory.open(id)`: construct-if-missing + retain, with
 * a handle that implements `Symbol.dispose` for scope-bound usage:
 *
 * ```ts
 * // Manual
 * const h = docs.open('abc');
 * h.content.write('hi');
 * h.release();
 *
 * // Scope-bound (preferred)
 * {
 *   using h = docs.open('abc');
 *   h.content.write('hi');
 * }  // release fires here
 *
 * // Async — wait for whenLoaded before using
 * {
 *   await using h = await docs.read('abc');
 *   const text = h.content.read();
 * }
 *
 * // Non-retaining cache lookup
 * const snap = docs.peek('abc');
 * ```
 *
 * The user owns `new Y.Doc(...)` (full control over `guid`, `gc`, `meta`, …)
 * and any attachments (`attachIndexedDb`, `attachSync`, content bindings, and
 * local `onLocalUpdate` writebacks). The framework's job is:
 *
 * - One Y.Doc per id (cache keyed by `id`, concurrent-open race-safe — no
 *   `await` between `Map.get` and `Map.set`).
 * - Guid-stability check — catches nondeterministic `guid` templates
 *   (e.g., `Math.random()`) on the second construction.
 * - Ref-count + grace-period disposal. Each `open()` increments the count and
 *   mints a fresh disposable wrapper; `release()` (or scope exit via `using`)
 *   decrements. Last release schedules disposal after `graceMs`; a fresh
 *   `open()` during grace cancels the pending disposal.
 * - Aggregated `whenLoaded`: scans top-level attachments for a
 *   `whenLoaded: Promise<void>` property and `Promise.all`s them.
 * - `close(id)` forces immediate disposal; `closeAll()` coordinates app
 *   teardown.
 *
 * Disposal destroys the user's Y.Doc via `ydoc.destroy()`. Attachments that
 * register `ydoc.on('destroy', …)` (as `attachIndexedDb` and `attachSync` do)
 * tear down automatically.
 *
 * @module
 */

import type * as Y from 'yjs';
import type {
	DocumentFactory,
	DocumentHandle,
	DocumentSnapshot,
} from './define-document.types.js';

const DEFAULT_GRACE_MS = 30_000;
const RESERVED_KEYS: ReadonlyArray<string | symbol> = [
	'retain',
	'release',
	'whenLoaded',
	Symbol.dispose,
	Symbol.asyncDispose,
];

type CachedHandle<TAttach extends { ydoc: Y.Doc }> = DocumentSnapshot<TAttach> & {
	retain(): () => void;
};

type DocEntry<TAttach extends { ydoc: Y.Doc }> = {
	handle: CachedHandle<TAttach>;
	bindCount: number;
	disposeTimer: ReturnType<typeof setTimeout> | null;
	disposed: boolean;
	/**
	 * Aggregated `disposed` promises from attachments whose teardown is async
	 * (e.g., `attachIndexedDb` resolves after IDB close completes). Resolves
	 * once every attachment has finished its async teardown. `close(id)` and
	 * `closeAll()` await this so callers can rely on "await factory.close(…)"
	 * as a real teardown barrier.
	 */
	whenDisposed: Promise<void>;
	resolveDisposed: () => void;
};

/**
 * Create a document factory from a user-owned build closure.
 *
 * @param build - Closure invoked on cache miss. Must return `{ ydoc, ... }`.
 *                `ydoc.guid` should be a deterministic function of `id` —
 *                the framework asserts stability on the second construction.
 *                Must NOT return top-level `retain`, `release`, `whenLoaded`,
 *                or the `Symbol.dispose`/`Symbol.asyncDispose` keys — those
 *                names are reserved by the framework.
 * @param opts  - `graceMs` (default 30_000): milliseconds to wait after the
 *                last retain release before destroying the Y.Doc. A fresh
 *                retain during grace cancels the pending disposal.
 */
export function defineDocument<
	Id extends string,
	TAttach extends { ydoc: Y.Doc },
>(
	build: (id: Id) => TAttach,
	opts?: { graceMs?: number },
): DocumentFactory<Id, TAttach> {
	const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
	const openDocuments = new Map<Id, DocEntry<TAttach>>();
	const recordedGuids = new Map<Id, string>();
	let warnedGet = false;
	let warnedRetain = false;

	/**
	 * Scan top-level attachments for a `Promise` at `key`, excluding the
	 * Y.Doc itself (Y.Doc exposes a `whenLoaded` for subdoc loading that
	 * never resolves in the standalone case).
	 */
	function aggregatePromise(
		attach: TAttach,
		key: 'whenLoaded' | 'disposed',
	): Promise<void> {
		const promises: Promise<unknown>[] = [];
		for (const [k, value] of Object.entries(attach)) {
			if (k === 'ydoc') continue;
			if (value && typeof value === 'object' && key in value) {
				const p = (value as unknown as Record<string, unknown>)[key];
				if (p instanceof Promise) promises.push(p);
			}
		}
		if (promises.length === 0) return Promise.resolve();
		return Promise.all(promises).then(() => {});
	}

	function construct(id: Id): DocEntry<TAttach> {
		// User closure runs synchronously. If it throws, we DON'T insert into
		// the cache — next `.open(sameId)` re-runs the closure (no poisoned
		// cache entry). The caller sees the thrown error.
		const attach = build(id);

		// Reserved-key collision: framework adds `retain`/`whenLoaded` to the
		// cached handle and `release`/`Symbol.dispose`/`Symbol.asyncDispose`
		// to each `open()` wrapper. If the user's attach already has any of
		// them, the framework would silently overwrite — fail loudly instead.
		for (const reserved of RESERVED_KEYS) {
			if (reserved in attach) {
				try {
					attach.ydoc.destroy();
				} catch {
					// best-effort — surface the key-collision error
				}
				throw new Error(
					`[defineDocument] build closure for id=${String(id)} returned reserved key "${String(reserved)}". ` +
						`"retain", "release", "whenLoaded", and the Symbol.dispose/Symbol.asyncDispose keys are added by the framework — pick a different attachment name.`,
				);
			}
		}

		const recorded = recordedGuids.get(id);
		if (recorded !== undefined && recorded !== attach.ydoc.guid) {
			// Don't leak the half-built Y.Doc — destroy before throwing so
			// the caller's attachments can clean up via their destroy hooks.
			try {
				attach.ydoc.destroy();
			} catch {
				// best-effort — surface the stability error, not the destroy error
			}
			throw new Error(
				`[defineDocument] guid instability for id=${String(id)}: ` +
					`expected ${recorded}, got ${attach.ydoc.guid}. ` +
					`Ensure your build closure produces a deterministic guid.`,
			);
		}
		if (recorded === undefined) {
			recordedGuids.set(id, attach.ydoc.guid);
		}

		const whenLoaded = aggregatePromise(attach, 'whenLoaded');
		const attachmentDisposed = aggregatePromise(attach, 'disposed');

		// The cached handle IS the attach object with `whenLoaded` and the
		// deprecated `retain` added in-place. We mutate (rather than
		// `Object.assign({}, …)`) to preserve live getters that some
		// attachments expose (e.g. Timeline's `currentType`). `open()`
		// wrappers wear `release`/`Symbol.dispose` on fresh objects created
		// with `Object.create(handle)` — the cached handle never gets those.
		const handle = attach as CachedHandle<TAttach>;

		const { promise: whenDisposed, resolve: resolveDisposed } =
			Promise.withResolvers<void>();

		const entry: DocEntry<TAttach> = {
			handle,
			bindCount: 0,
			disposeTimer: null,
			disposed: false,
			whenDisposed,
			resolveDisposed: () => {
				// Gate the factory-level "disposed" on attachment-level disposed
				// promises so callers awaiting close()/closeAll() see IDB, sync,
				// etc. fully torn down — not just the synchronous ydoc.destroy()
				// that triggered them.
				void attachmentDisposed.then(resolveDisposed, resolveDisposed);
			},
		};

		const retain = (): (() => void) => {
			if (!warnedRetain) {
				warnedRetain = true;
				console.warn(
					'[defineDocument] handle.retain() is deprecated — use factory.open(id) and handle.release() instead.',
				);
			}
			// Defensive: a retain() on a disposed entry shouldn't resurrect it.
			// In practice, a `close()` evicts the entry from the cache, so a
			// fresh `.open()` constructs a new one. But stale handle references
			// can reach `retain` here.
			if (entry.disposed) return () => {};

			if (entry.disposeTimer !== null) {
				clearTimeout(entry.disposeTimer);
				entry.disposeTimer = null;
			}
			entry.bindCount++;

			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (entry.disposed) return;
				entry.bindCount--;
				if (entry.bindCount === 0) {
					entry.disposeTimer = setTimeout(() => {
						entry.disposeTimer = null;
						if (entry.disposed) return;
						// Grace elapsed with no fresh retain — dispose.
						disposeEntry(id, entry);
					}, graceMs);
				}
			};
		};

		Object.defineProperties(handle, {
			whenLoaded: { value: whenLoaded, enumerable: true, configurable: true },
			retain: { value: retain, enumerable: true, configurable: true },
		});

		openDocuments.set(id, entry);
		return entry;
	}

	function disposeEntry(id: Id, entry: DocEntry<TAttach>): void {
		entry.disposed = true;
		if (entry.disposeTimer !== null) {
			clearTimeout(entry.disposeTimer);
			entry.disposeTimer = null;
		}
		// Remove from cache synchronously so a concurrent `.open()` constructs
		// a fresh entry rather than handing out the about-to-be-destroyed one.
		if (openDocuments.get(id) === entry) {
			openDocuments.delete(id);
		}
		// Destroying the Y.Doc fires `ydoc.on('destroy')` — attachments that
		// registered teardown there (IndexedDB, sync) run their cleanup. Any
		// async close (IDB, WebSocket) settles in the background; callers who
		// care can await attachment-specific `.disposed` promises exposed in
		// their returns.
		try {
			entry.handle.ydoc.destroy();
		} catch (err) {
			console.error('[defineDocument] ydoc.destroy() threw:', err);
		}
		// Kick off the factory-level disposed resolution. Resolves once every
		// attachment's own `.disposed` promise has settled (success or not).
		entry.resolveDisposed();
	}

	/**
	 * Mint a fresh disposable wrapper for an open entry. Each wrapper holds
	 * its own `released` flag and release closure, so N `open()` calls require
	 * N releases before the grace timer starts. The wrapper inherits all
	 * attach properties (ydoc, whenLoaded, …) from the cached handle via
	 * `Object.create`.
	 */
	function makeOpenWrapper(
		id: Id,
		entry: DocEntry<TAttach>,
	): DocumentHandle<TAttach> {
		if (entry.disposeTimer !== null) {
			clearTimeout(entry.disposeTimer);
			entry.disposeTimer = null;
		}
		entry.bindCount++;

		let released = false;
		const release = (): void => {
			if (released) return;
			released = true;
			if (entry.disposed) return;
			entry.bindCount--;
			if (entry.bindCount === 0) {
				entry.disposeTimer = setTimeout(() => {
					entry.disposeTimer = null;
					if (entry.disposed) return;
					disposeEntry(id, entry);
				}, graceMs);
			}
		};

		const wrapper = Object.create(entry.handle) as DocumentHandle<TAttach>;
		Object.defineProperties(wrapper, {
			release: { value: release, enumerable: false, configurable: true },
			[Symbol.dispose]: {
				value: release,
				enumerable: false,
				configurable: true,
			},
			[Symbol.asyncDispose]: {
				value: () => {
					release();
					return Promise.resolve();
				},
				enumerable: false,
				configurable: true,
			},
		});
		return wrapper;
	}

	const factory: DocumentFactory<Id, TAttach> = {
		open(id) {
			let entry = openDocuments.get(id);
			if (!entry) entry = construct(id);
			return makeOpenWrapper(id, entry);
		},

		peek(id) {
			const entry = openDocuments.get(id);
			if (!entry) return undefined;
			return entry.handle as unknown as DocumentSnapshot<TAttach>;
		},

		async read(id) {
			const handle = factory.open(id);
			await handle.whenLoaded;
			return handle;
		},

		get(id) {
			if (!warnedGet) {
				warnedGet = true;
				console.warn(
					'[defineDocument] factory.get() is deprecated — use factory.open() + handle.release(), or factory.peek() for non-retaining reads.',
				);
			}
			const existing = openDocuments.get(id);
			if (existing) return existing.handle as unknown as DocumentHandle<TAttach>;
			return construct(id).handle as unknown as DocumentHandle<TAttach>;
		},

		async close(id) {
			const entry = openDocuments.get(id);
			if (!entry) return;
			disposeEntry(id, entry);
			await entry.whenDisposed;
		},

		async closeAll() {
			const entries = Array.from(openDocuments.entries());
			openDocuments.clear();
			for (const [id, entry] of entries) disposeEntry(id, entry);
			await Promise.all(entries.map(([, entry]) => entry.whenDisposed));
		},
	};

	return factory;
}
