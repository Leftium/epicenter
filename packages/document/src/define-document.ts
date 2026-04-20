/**
 * `defineDocument` — the single primitive for constructing a managed Y.Doc.
 *
 * Accepts a user-owned `build(id) => { ydoc, ...attachments }` closure and
 * wraps it with a cache, ref-count + grace-period lifecycle, aggregated
 * `whenLoaded` readiness, and coordinated teardown.
 *
 * The user owns `new Y.Doc(...)` (full control over `guid`, `gc`, `meta`, …)
 * and any attachments (`attachIndexedDb`, `attachSync`, content bindings, and
 * local `onLocalUpdate` writebacks). The framework's job is:
 *
 * - One Y.Doc per id (cache keyed by `id`, concurrent-get race-safe — no
 *   `await` between `Map.get` and `Map.set`).
 * - Guid-stability check — catches nondeterministic `guid` templates
 *   (e.g., `Math.random()`) on the second `.get(sameId)`.
 * - Ref-count + grace-period disposal. `bind()` returns an idempotent
 *   release closure; last release schedules disposal after `graceMs`;
 *   a fresh bind before grace elapses cancels the pending disposal.
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
import type { DocumentFactory, DocumentHandle } from './types.js';

const DEFAULT_GRACE_MS = 30_000;

type DocEntry<TAttach extends { ydoc: Y.Doc }> = {
	handle: DocumentHandle<TAttach>;
	bindCount: number;
	disposeTimer: ReturnType<typeof setTimeout> | null;
	disposed: boolean;
};

/**
 * Create a document factory from a user-owned build closure.
 *
 * @param build - Closure invoked on cache miss. Must return `{ ydoc, ... }`.
 *                `ydoc.guid` should be a deterministic function of `id` —
 *                the framework asserts stability on the second construction.
 * @param opts  - `graceMs` (default 30_000): milliseconds to wait after the
 *                last bind release before destroying the Y.Doc. A fresh
 *                bind during grace cancels the pending disposal.
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

	function aggregateWhenLoaded(attach: TAttach): Promise<void> {
		// Scan attachments (not the Y.Doc itself — Y.Doc exposes a
		// `whenLoaded` for subdoc loading that never resolves in the normal
		// standalone case) for a `whenLoaded: Promise<void>` field.
		const promises: Promise<unknown>[] = [];
		for (const [key, value] of Object.entries(attach)) {
			if (key === 'ydoc') continue;
			if (value && typeof value === 'object' && 'whenLoaded' in value) {
				const p = (value as { whenLoaded: unknown }).whenLoaded;
				if (p instanceof Promise) promises.push(p);
			}
		}
		if (promises.length === 0) return Promise.resolve();
		return Promise.all(promises).then(() => {});
	}

	function construct(id: Id): DocEntry<TAttach> {
		// User closure runs synchronously. If it throws, we DON'T insert into
		// the cache — next `.get(sameId)` re-runs the closure (no poisoned
		// cache entry). The caller sees the thrown error.
		const attach = build(id);

		// Runtime ydoc presence check (TS constraint `TAttach extends {
		// ydoc: Y.Doc }` already enforces this at compile time; the runtime
		// check catches TS escape hatches).
		if (!attach || !attach.ydoc || typeof attach.ydoc.destroy !== 'function') {
			throw new Error(
				`[defineDocument] build closure for id=${String(id)} did not return a { ydoc: Y.Doc, ... } object`,
			);
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

		const whenLoaded = aggregateWhenLoaded(attach);

		// The handle IS the attach object with `whenLoaded` and `bind` added
		// in-place. We mutate (rather than `Object.assign({}, …)`) to preserve
		// live getters that some attachments expose (e.g. Timeline's
		// `currentType`).
		const handle = attach as DocumentHandle<TAttach>;

		const entry: DocEntry<TAttach> = {
			handle,
			bindCount: 0,
			disposeTimer: null,
			disposed: false,
		};

		const bind = (): (() => void) => {
			// Defensive: a bind() on a disposed entry shouldn't resurrect it.
			// In practice, a `close()` evicts the entry from the cache, so a
			// fresh `.get()` constructs a new one. But stale handle references
			// can reach `bind` here.
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
						// Grace elapsed with no fresh bind — dispose.
						disposeEntry(id, entry);
					}, graceMs);
				}
			};
		};

		Object.defineProperties(handle, {
			whenLoaded: { value: whenLoaded, enumerable: true, configurable: true },
			bind: { value: bind, enumerable: true, configurable: true },
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
		// Remove from cache synchronously so a concurrent `.get()` constructs
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
	}

	const factory: DocumentFactory<Id, TAttach> = {
		get(id) {
			const existing = openDocuments.get(id);
			if (existing) return existing.handle;
			return construct(id).handle;
		},

		async read(id) {
			const handle = factory.get(id);
			await handle.whenLoaded;
			return handle;
		},

		async close(id) {
			const entry = openDocuments.get(id);
			if (!entry) return;
			disposeEntry(id, entry);
		},

		async closeAll() {
			const entries = Array.from(openDocuments.entries());
			openDocuments.clear();
			for (const [id, entry] of entries) {
				try {
					disposeEntry(id, entry);
				} catch (err) {
					console.error('[defineDocument] closeAll dispose error:', err);
				}
			}
		},
	};

	return factory;
}
