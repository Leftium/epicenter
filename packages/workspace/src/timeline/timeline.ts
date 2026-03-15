import * as Y from 'yjs';
import type {
	ContentMode,
	RichTextEntry,
	SheetEntry,
	TextEntry,
} from './entries.js';
import { xmlFragmentToPlaintext } from './richtext.js';
import { parseSheetFromCsv, serializeSheetToCsv } from './sheet.js';

type TimelineYMap = Y.Map<unknown>;

export type Timeline = {
	/** Number of entries in the timeline. */
	readonly length: number;
	/** The most recent entry, or undefined if empty. O(1). */
	readonly currentEntry: TimelineYMap | undefined;
	/** Content mode of the current entry, or undefined if empty. */
	readonly currentMode: ContentMode | undefined;
	/** Append a new text entry. Returns all atomically-set fields. */
	pushText(content: string): TextEntry;
	/** Append a new empty sheet entry. Returns all atomically-set fields. */
	pushSheet(): SheetEntry;
	/** Append a new empty richtext entry. Returns all atomically-set fields. */
	pushRichtext(): RichTextEntry;
	/** Append a sheet entry populated from a CSV string. Returns all atomically-set fields. */
	pushSheetFromCsv(csv: string): SheetEntry;
	/**
	 * Replace the current text content in-place, or push a new text entry
	 * if the current mode is not text.
	 *
	 * This is the canonical "write text" operation that `DocumentHandle.write()`
	 * delegates to. Callers are responsible for wrapping in `ydoc.transact()`
	 * if batching is desired.
	 */
	replaceCurrentText(content: string): void;
	/**
	 * Append a new richtext entry whose content is deep-cloned from the
	 * given source fragment. Formatting (bold, italic, headings, links) is
	 * fully preserved via `Y.XmlElement.clone()`.
	 *
	 * Use this for snapshot restore or cross-doc content transfer where
	 * formatting must survive the move between Y.Doc instances.
	 */
	pushRichtextFromFragment(source: Y.XmlFragment): RichTextEntry;
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
	const timeline = ydoc.getArray<TimelineYMap>('timeline');

	function currentEntry(): TimelineYMap | undefined {
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

		pushText(content: string): TextEntry {
			const entry = new Y.Map();
			entry.set('type', 'text');
			const ytext = new Y.Text();
			ytext.insert(0, content);
			entry.set('content', ytext);
			const createdAt = Date.now();
			entry.set('createdAt', createdAt);
			timeline.push([entry]);
			return { type: 'text', content: ytext, createdAt };
		},

		pushSheet(): SheetEntry {
			const entry = new Y.Map();
			entry.set('type', 'sheet');
			const columns = new Y.Map<Y.Map<string>>();
			const rows = new Y.Map<Y.Map<string>>();
			entry.set('columns', columns);
			entry.set('rows', rows);
			const createdAt = Date.now();
			entry.set('createdAt', createdAt);
			timeline.push([entry]);
			return { type: 'sheet', columns, rows, createdAt };
		},

		pushRichtext(): RichTextEntry {
			const entry = new Y.Map();
			entry.set('type', 'richtext');
			const content = new Y.XmlFragment();
			const frontmatter = new Y.Map<unknown>();
			entry.set('content', content);
			entry.set('frontmatter', frontmatter);
			const createdAt = Date.now();
			entry.set('createdAt', createdAt);
			timeline.push([entry]);
			return { type: 'richtext', content, frontmatter, createdAt };
		},

		pushSheetFromCsv(csv: string): SheetEntry {
			const entry = new Y.Map();
			entry.set('type', 'sheet');
			const columns = new Y.Map<Y.Map<string>>();
			const rows = new Y.Map<Y.Map<string>>();
			entry.set('columns', columns);
			entry.set('rows', rows);
			parseSheetFromCsv(csv, columns, rows);
			const createdAt = Date.now();
			entry.set('createdAt', createdAt);
			timeline.push([entry]);
			return { type: 'sheet', columns, rows, createdAt };
		},

		replaceCurrentText(content: string) {
			if (currentMode() === 'text') {
				const ytext = currentEntry()!.get('content') as Y.Text;
				ytext.delete(0, ytext.length);
				ytext.insert(0, content);
			} else {
				this.pushText(content);
			}
		},

		pushRichtextFromFragment(source: Y.XmlFragment): RichTextEntry {
			const result = this.pushRichtext();
			const children = source
				.toArray()
				.filter(
					(c): c is Y.XmlElement | Y.XmlText =>
						c instanceof Y.XmlElement || c instanceof Y.XmlText,
				)
				.map((c) => c.clone());
			result.content.insert(0, children);
			return result;
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
 * Richtext content is deep-cloned via `Y.XmlFragment.clone()`—formatting
 * (bold, italic, headings, links) is fully preserved.
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
				ydoc.transact(() => liveTl.replaceCurrentText(text));
				break;
			}
			case 'sheet': {
				const csv = serializeSheetToCsv(entry.columns, entry.rows);
				ydoc.transact(() => liveTl.pushSheetFromCsv(csv));
				break;
			}
			case 'richtext': {
				ydoc.transact(() => liveTl.pushRichtextFromFragment(entry.content));
				break;
			}
			case 'empty':
				break;
		}
	} finally {
		tempDoc.destroy();
	}
}
