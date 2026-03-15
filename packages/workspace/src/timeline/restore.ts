/**
 * Snapshot restore via timeline.
 *
 * Restores a live document's content to match a past snapshot. The snapshot
 * binary is a full Y.Doc state (from `Y.encodeStateAsUpdateV2` on the DO).
 * The restore creates new forward CRDT operations—Yjs is append-only, so
 * "restoring" means writing new ops that make visible content match the snapshot.
 *
 * This is a pure function (Y.Doc operations only, no network calls). The caller
 * orchestrates API calls for safety snapshots before invoking this.
 *
 * @module
 */
import * as Y from 'yjs';
import type { DocumentHandle } from '../workspace/types.js';
import {
	populateFragmentFromText,
	xmlFragmentToPlaintext,
} from './richtext.js';
import { serializeSheetToCsv } from './sheet.js';
import { createTimeline, readEntry } from './timeline.js';

/**
 * Restore a document's content to match a past snapshot.
 *
 * Creates a temporary Y.Doc from the snapshot binary, reads its timeline entry,
 * and writes the content to the live document's timeline via `DocumentHandle`.
 * Mode-aware: text snapshots restore as text, sheet as sheet, richtext as
 * richtext (flattened to plaintext, then repopulated as paragraphs).
 *
 * The caller is responsible for saving a safety snapshot before calling this.
 *
 * @param handle - The live document's handle (wraps the Y.Doc and timeline)
 * @param snapshotBinary - Full snapshot state as `Uint8Array` from `Y.encodeStateAsUpdateV2`
 *
 * @example
 * ```typescript
 * // 1. Save safety snapshot via API
 * await api.saveSnapshot(docId, 'Before restore');
 *
 * // 2. Fetch snapshot binary
 * const binary = await api.getSnapshot(docId, snapshotId);
 *
 * // 3. Restore
 * restoreFromSnapshot(handle, binary);
 * ```
 */
export function restoreFromSnapshot(
	handle: DocumentHandle,
	snapshotBinary: Uint8Array,
): void {
	const tempDoc = new Y.Doc({ gc: false });
	try {
		Y.applyUpdateV2(tempDoc, snapshotBinary);

		const snapshotTimeline = createTimeline(tempDoc);
		const entry = readEntry(snapshotTimeline.currentEntry);

		switch (entry.mode) {
			case 'text': {
				const text = entry.content.toString();
				handle.write(text);
				break;
			}
			case 'sheet': {
				const csv = serializeSheetToCsv(entry.columns, entry.rows);
				handle.batch(() => handle.timeline.pushSheetFromCsv(csv));
				break;
			}
			case 'richtext': {
				const plaintext = xmlFragmentToPlaintext(entry.content);
				handle.batch(() => {
					const rtEntry = handle.timeline.pushRichtext();
					const fragment = rtEntry.get('content') as Y.XmlFragment;
					populateFragmentFromText(fragment, plaintext);
				});
				break;
			}
			case 'empty':
				break;
		}
	} finally {
		tempDoc.destroy();
	}
}
