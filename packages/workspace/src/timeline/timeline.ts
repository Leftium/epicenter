import * as Y from 'yjs';
import type { ContentMode } from './entries.js';
import { populateFragmentFromText, xmlFragmentToPlaintext } from './richtext.js';
import { parseSheetFromCsv, serializeSheetToCsv } from './sheet.js';

type TimelineEntry = Y.Map<unknown>;

export type Timeline = {
	/** Number of entries in the timeline. */
	readonly length: number;
	/** The most recent entry, or undefined if empty. O(1). */
	readonly currentEntry: TimelineEntry | undefined;
	/** Content mode of the current entry, or undefined if empty. */
	readonly currentMode: ContentMode | undefined;
	/** Append a new text entry. Returns the Y.Map. */
	pushText(content: string): TimelineEntry;
	/** Append a new empty sheet entry. Returns the Y.Map. */
	pushSheet(): TimelineEntry;
	/** Append a new empty richtext entry. Returns the Y.Map. */
	pushRichtext(): TimelineEntry;
	/** Append a sheet entry populated from a CSV string. Returns the Y.Map. */
	pushSheetFromCsv(csv: string): TimelineEntry;
	/** Read the current entry as a string. Returns '' if empty. */
	readAsString(): string;
};

export type ValidatedEntry =
	| { mode: 'text'; content: Y.Text; createdAt: number }
	| {
			mode: 'richtext';
			content: Y.XmlFragment;
			frontmatter: Y.Map<unknown>;
			createdAt: number;
	  }
	| {
			mode: 'sheet';
			columns: Y.Map<Y.Map<string>>;
			rows: Y.Map<Y.Map<string>>;
			createdAt: number;
	  }
	| { mode: 'empty' };

export function createTimeline(ydoc: Y.Doc): Timeline {
	const timeline = ydoc.getArray<TimelineEntry>('timeline');

	function currentEntry(): TimelineEntry | undefined {
		if (timeline.length === 0) return undefined;
		return timeline.get(timeline.length - 1);
	}

	function currentMode(): ContentMode | undefined {
		const entry = currentEntry();
		return entry ? (entry.get('type') as ContentMode) : undefined;
	}

	return {
		get length() {
			return timeline.length;
		},
		get currentEntry() {
			return currentEntry();
		},
		get currentMode() {
			return currentMode();
		},

		pushText(content: string): TimelineEntry {
			const entry = new Y.Map();
			entry.set('type', 'text');
			const ytext = new Y.Text();
			ytext.insert(0, content);
			entry.set('content', ytext);
			entry.set('createdAt', Date.now());
			timeline.push([entry]);
			return entry;
		},

		pushSheet(): TimelineEntry {
			const entry = new Y.Map();
			entry.set('type', 'sheet');
			entry.set('columns', new Y.Map());
			entry.set('rows', new Y.Map());
			entry.set('createdAt', Date.now());
			timeline.push([entry]);
			return entry;
		},

		pushRichtext(): TimelineEntry {
			const entry = new Y.Map();
			entry.set('type', 'richtext');
			entry.set('content', new Y.XmlFragment());
			entry.set('frontmatter', new Y.Map());
			entry.set('createdAt', Date.now());
			timeline.push([entry]);
			return entry;
		},

		pushSheetFromCsv(csv: string): TimelineEntry {
			const entry = new Y.Map();
			entry.set('type', 'sheet');
			const columns = new Y.Map<Y.Map<string>>();
			const rows = new Y.Map<Y.Map<string>>();
			entry.set('columns', columns);
			entry.set('rows', rows);
			parseSheetFromCsv(csv, columns, rows);
			entry.set('createdAt', Date.now());
			timeline.push([entry]);
			return entry;
		},

		readAsString(): string {
			const validated = readEntry(currentEntry());
			switch (validated.mode) {
				case 'text':
					return validated.content.toString();
				case 'richtext':
					return xmlFragmentToPlaintext(validated.content);
				case 'sheet':
					return serializeSheetToCsv(validated.columns, validated.rows);
				case 'empty':
					return '';
			}
		},
	};
}

export function readEntry(entry: Y.Map<unknown> | undefined): ValidatedEntry {
	if (!entry) return { mode: 'empty' };

	const type = entry.get('type');
	const createdAt = (entry.get('createdAt') as number) ?? 0;

	if (type === 'text') {
		const content = entry.get('content');
		if (content instanceof Y.Text) return { mode: 'text', content, createdAt };
	}

	if (type === 'richtext') {
		const content = entry.get('content');
		const frontmatter = entry.get('frontmatter');
		if (content instanceof Y.XmlFragment && frontmatter instanceof Y.Map) {
			return { mode: 'richtext', content, frontmatter, createdAt };
		}
	}

	if (type === 'sheet') {
		const columns = entry.get('columns');
		const rows = entry.get('rows');
		if (columns instanceof Y.Map && rows instanceof Y.Map) {
			return {
				mode: 'sheet',
				columns: columns as Y.Map<Y.Map<string>>,
				rows: rows as Y.Map<Y.Map<string>>,
				createdAt,
			};
		}
	}

	return { mode: 'empty' };
}

/**
 * Restore a document's content to match a past snapshot.
 *
 * Creates a temporary Y.Doc from the snapshot binary, reads its timeline entry,
 * and writes matching content to the live Y.Doc's timeline. Mode-aware: text
 * snapshots replace in-place (if the live doc is already text) or push a new
 * entry; sheet and richtext always push new entries.
 *
 * Richtext is flattened to plaintext—formatting is not preserved. See
 * `populateFragmentFromText` for the conversion.
 *
 * The caller is responsible for saving a safety snapshot before calling this.
 *
 * @param ydoc - The live document's Y.Doc (must have `gc: false`)
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
 * restoreFromSnapshot(handle.ydoc, binary);
 * ```
 */
export function restoreFromSnapshot(
	ydoc: Y.Doc,
	snapshotBinary: Uint8Array,
): void {
	const tempDoc = new Y.Doc({ gc: false });
	try {
		Y.applyUpdateV2(tempDoc, snapshotBinary);

		const snapshotTl = createTimeline(tempDoc);
		const entry = readEntry(snapshotTl.currentEntry);

		const liveTl = createTimeline(ydoc);

		switch (entry.mode) {
			case 'text': {
				const text = entry.content.toString();
				if (liveTl.currentMode === 'text') {
					const ytext = liveTl.currentEntry!.get('content') as Y.Text;
					ydoc.transact(() => {
						ytext.delete(0, ytext.length);
						ytext.insert(0, text);
					});
				} else {
					ydoc.transact(() => liveTl.pushText(text));
				}
				break;
			}
			case 'sheet': {
				const csv = serializeSheetToCsv(entry.columns, entry.rows);
				ydoc.transact(() => liveTl.pushSheetFromCsv(csv));
				break;
			}
			case 'richtext': {
				const plaintext = xmlFragmentToPlaintext(entry.content);
				ydoc.transact(() => {
					const rtEntry = liveTl.pushRichtext();
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
