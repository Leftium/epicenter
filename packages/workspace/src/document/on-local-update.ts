/**
 * onLocalUpdate — register a Y.Doc listener for local mutations only.
 *
 * Filters on `transaction.local`, Yjs's own invariant: `true` iff the update
 * originated from a direct mutation on this Y.Doc, `false` for anything
 * applied via `Y.applyUpdate` (sync transports, IndexedDB hydration, broadcast
 * channel replay). This is semantic — it doesn't depend on origin-shape
 * conventions and can't be fooled by a third-party provider that uses a
 * symbol origin.
 *
 * Empty transactions (no Y types changed) are skipped so `ydoc.transact(() => {})`
 * marker calls don't trigger callbacks.
 *
 * Typical use: bump a parent row's `updatedAt` when its content doc is
 * edited locally, without re-triggering on remote/persisted updates.
 */
import type * as Y from 'yjs';

export function onLocalUpdate(ydoc: Y.Doc, fn: () => void): () => void {
	const handler = (tx: Y.Transaction) => {
		if (!tx.local) return;
		if (tx.changed.size === 0) return;
		try {
			fn();
		} catch (err) {
			console.error('[onLocalUpdate] callback threw:', err);
		}
	};
	ydoc.on('afterTransaction', handler);
	return () => ydoc.off('afterTransaction', handler);
}
