/**
 * onLocalUpdate — register a Y.Doc update listener that ignores transport echoes.
 *
 * Filter rule: callback fires only when the update's origin is a non-Symbol
 * value (typically `null` for direct mutations, or a `PluginKey`-like object
 * from y-prosemirror). Symbol origins — `SYNC_ORIGIN`, `BC_ORIGIN`, and the
 * internal `DOCUMENTS_ORIGIN` — represent transport echoes or framework
 * writebacks and are skipped, so a collaborator's edit arriving via sync
 * doesn't re-trigger a local metadata bump.
 *
 * `DOCUMENTS_ORIGIN` is internal to this module and the test that verifies
 * the filter. It's reserved for a future "framework tags its own writebacks"
 * use case — not currently exported from the package barrel, because no
 * consumer tags transactions with it today.
 */
import type * as Y from 'yjs';

export const DOCUMENTS_ORIGIN: unique symbol = Symbol('documents');

export function onLocalUpdate(ydoc: Y.Doc, fn: () => void): () => void {
	const handler = (_update: Uint8Array, origin: unknown) => {
		// Any Symbol origin is a transport echo or tagged writeback — skip.
		// Non-Symbol origins (null, PluginKey objects, etc.) are local edits.
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
