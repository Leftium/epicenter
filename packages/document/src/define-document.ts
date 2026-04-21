/**
 * `defineDocument` — the single primitive for constructing a managed Y.Doc.
 *
 * Accepts a user-owned `build(id) => { ydoc, ...attachments }` closure and
 * wraps it with a cache, ref-count + grace-period lifecycle, aggregated
 * `whenLoaded` readiness, and coordinated teardown.
 *
 * The only construction path is `factory.open(id)`: construct-if-missing +
 * retain. The returned handle carries a `dispose()` method for manual
 * teardown and also implements `Symbol.dispose` for TS 5.2 `using` blocks.
 *
 * ```ts
 * // Manual — pair every open() with a dispose()
 * const h = docs.open('abc');
 * await h.whenLoaded;
 * h.content.write('hi');
 * h.dispose();
 *
 * // Framework-scoped — register dispose with the component lifecycle
 * $effect(() => {
 *   const h = docs.open(id);
 *   return () => h.dispose();
 * });
 *
 * // Scope-bound (TS 5.2 `using`) — dispose fires on block exit
 * {
 *   using h = docs.open('abc');
 *   await h.whenLoaded;
 *   h.content.write('hi');
 * }
 *
 * // Async scope — same as `using`, for symmetry with async teardown
 * {
 *   await using h = docs.open('abc');
 *   await h.whenLoaded;
 *   h.content.read();
 * }
 * ```
 *
 * The user owns `new Y.Doc(...)` (full control over `guid`, `gc`, `meta`, …)
 * and any attachments (`attachIndexedDb`, `attachSync`, content bindings, and
 * local `onLocalUpdate` writebacks). The framework's job is:
 *
 * - One Y.Doc per id (cache keyed by `id`, concurrent-open race-safe — no
 *   `await` between `Map.get` and `Map.set`).
 * - Guid-stability check — catches nondeterministic `guid` templates
 *   (e.g., `Math.random()`) on the second construction. Silent IDB data
 *   corruption is the bug this guards against.
 * - Ref-count + grace-period disposal. Each `open()` increments the count and
 *   mints a fresh disposable handle; `dispose()` decrements. Last dispose
 *   schedules teardown after `graceMs`; a fresh `open()` during grace cancels
 *   the pending disposal. The grace period is load-bearing for correctness
 *   with async-teardown attachments like `attachIndexedDb`: `db.close()` is
 *   deferred until pending transactions settle, so immediate destroy+rebuild
 *   on the same id can race.
 * - Aggregated `whenLoaded`: scans top-level attachments for a
 *   `whenLoaded: Promise<void>` property and `Promise.all`s them.
 * - `close(id)` forces immediate disposal and awaits attachments'
 *   `disposed: Promise<void>` fields — `await factory.close(id)` is a real
 *   teardown barrier callers can rely on before reusing the id.
 *
 * Disposal destroys the user's Y.Doc via `ydoc.destroy()`. Attachments that
 * register `ydoc.on('destroy', …)` (as `attachIndexedDb` and `attachSync` do)
 * tear down automatically.
 *
 * The user's `attach` object is never mutated. Framework-injected properties
 * (`whenLoaded`, `release`, `Symbol.dispose`/`asyncDispose`) live on the
 * per-handle wrapper that prototype-chains to the user's attach for reads.
 *
 * @module
 */

import type * as Y from 'yjs';
import type {
	DocumentFactory,
	DocumentHandle,
} from './define-document.types.js';

const DEFAULT_GRACE_MS = 30_000;
const RESERVED_KEYS: ReadonlyArray<string> = ['dispose', 'whenLoaded'];

type DocEntry<TAttach extends { ydoc: Y.Doc }> = {
	/** The user's pristine `build()` return value. Never mutated. */
	attach: TAttach;
	/** Aggregated across all attachments' `whenLoaded` promises. */
	whenLoaded: Promise<void>;
	/**
	 * Aggregated `disposed` promises from attachments whose teardown is async
	 * (e.g., `attachIndexedDb` resolves after IDB close completes). `close(id)`
	 * and `closeAll()` await this so callers can rely on "await factory.close(…)"
	 * as a real teardown barrier.
	 */
	attachmentDisposed: Promise<void>;
	retainCount: number;
	disposeTimer: ReturnType<typeof setTimeout> | null;
	disposed: boolean;
};

/**
 * Create a document factory from a user-owned build closure.
 *
 * @param build - Closure invoked on cache miss. Must return `{ ydoc, ... }`.
 *                `ydoc.guid` should be a deterministic function of `id` —
 *                the framework asserts stability on the second construction.
 *                Must NOT return top-level `dispose` or `whenLoaded` — those
 *                names are reserved by the framework.
 * @param opts  - `graceMs` (default 30_000): milliseconds to wait after the
 *                last handle dispose before destroying the Y.Doc. A fresh
 *                open during grace cancels the pending teardown.
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

		// Reserved-key collision: framework adds `whenLoaded`, `dispose`, and
		// the dispose symbols to each handle via `Object.create(attach)` +
		// `defineProperties`. A user property with the same name on `attach`
		// would be silently shadowed via the prototype chain — fail loudly.
		// (Symbol keys can't be returned from an object literal in practice;
		// skipped.)
		for (const reserved of RESERVED_KEYS) {
			if (reserved in attach) {
				try {
					attach.ydoc.destroy();
				} catch {
					// best-effort — surface the key-collision error
				}
				throw new Error(
					`[defineDocument] build closure for id=${String(id)} returned reserved key "${reserved}". ` +
						`"dispose" and "whenLoaded" are added by the framework — pick a different attachment name.`,
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

		const entry: DocEntry<TAttach> = {
			attach,
			whenLoaded: aggregatePromise(attach, 'whenLoaded'),
			attachmentDisposed: aggregatePromise(attach, 'disposed'),
			retainCount: 0,
			disposeTimer: null,
			disposed: false,
		};

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
		// `closeAll` pre-clears the map; this guard makes that path a no-op.
		if (openDocuments.get(id) === entry) {
			openDocuments.delete(id);
		}
		// `ydoc.destroy()` fires `ydoc.on('destroy')` — attachments that
		// registered teardown there (IndexedDB, sync) run their cleanup. Any
		// async close settles in the background; callers awaiting a full
		// teardown barrier do so via `close(id)`, which awaits
		// `entry.attachmentDisposed`.
		try {
			entry.attach.ydoc.destroy();
		} catch (err) {
			console.error('[defineDocument] ydoc.destroy() threw:', err);
		}
	}

	const factory: DocumentFactory<Id, TAttach> = {
		open(id) {
			// Each open() mints a fresh disposable handle with its own
			// `disposed` flag, so N opens require N disposes before the grace
			// timer starts. The handle prototype-chains to `entry.attach` — so
			// `h.ydoc` and any user attachment properties read through without
			// mutating the user's object.
			const entry = openDocuments.get(id) ?? construct(id);

			if (entry.disposeTimer !== null) {
				clearTimeout(entry.disposeTimer);
				entry.disposeTimer = null;
			}
			entry.retainCount++;

			let handleDisposed = false;
			const dispose = (): void => {
				if (handleDisposed) return;
				handleDisposed = true;
				if (entry.disposed) return;
				entry.retainCount--;
				if (entry.retainCount === 0) {
					entry.disposeTimer = setTimeout(() => {
						entry.disposeTimer = null;
						disposeEntry(id, entry);
					}, graceMs);
				}
			};

			const handle = Object.create(entry.attach) as DocumentHandle<TAttach>;
			Object.defineProperties(handle, {
				whenLoaded: { value: entry.whenLoaded, enumerable: true },
				dispose: { value: dispose },
				[Symbol.dispose]: { value: dispose },
				[Symbol.asyncDispose]: {
					value: () => {
						dispose();
						return Promise.resolve();
					},
				},
			});
			return handle;
		},

		async close(id) {
			const entry = openDocuments.get(id);
			if (!entry) return;
			disposeEntry(id, entry);
			await entry.attachmentDisposed;
		},

		async closeAll() {
			const entries = Array.from(openDocuments.entries());
			openDocuments.clear();
			for (const [id, entry] of entries) disposeEntry(id, entry);
			await Promise.all(
				entries.map(([, entry]) => entry.attachmentDisposed),
			);
		},
	};

	return factory;
}
