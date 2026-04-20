/**
 * onLocalUpdate — register a Y.Doc update listener that ignores transport echoes.
 *
 * The framework filter rule: callback fires only when the update's origin is
 * `null`/`undefined` OR the internal `DOCUMENTS_ORIGIN` symbol. Any other
 * Symbol origin is treated as a transport echo (sync, broadcast) and skipped
 * — those updates don't represent a local edit.
 *
 * `DOCUMENTS_ORIGIN` is exposed so user-owned metadata writebacks can tag
 * their transactions with it (via `ydoc.transact(fn, DOCUMENTS_ORIGIN)`) and
 * round-trip through the same filter without re-triggering themselves.
 */
import type * as Y from 'yjs';

export const DOCUMENTS_ORIGIN: unique symbol = Symbol('documents');

export function onLocalUpdate(ydoc: Y.Doc, fn: () => void): () => void {
	const handler = (_update: Uint8Array, origin: unknown) => {
		if (origin === DOCUMENTS_ORIGIN) return;
		if (typeof origin === 'symbol') return;
		try {
			fn();
		} catch (err) {
			console.error('[onLocalUpdate] callback threw:', err);
		}
	};
	ydoc.on('update', handler);
	return () => ydoc.off('update', handler);
}
