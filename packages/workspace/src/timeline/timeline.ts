import * as Y from 'yjs';
import type {
	ContentMode,
	RichTextEntry,
	SheetEntry,
	TextEntry,
} from './entries.js';
import {
	populateFragmentFromText,
	type SheetBinding,
	xmlFragmentToPlaintext,
} from './richtext.js';
import { parseSheetFromCsv, serializeSheetToCsv } from './sheet.js';

type TimelineYMap = Y.Map<unknown>;

export type Timeline = {
	/** The Y.Doc this timeline is bound to. */
	readonly ydoc: Y.Doc;
	/** Number of entries in the timeline. */
	readonly length: number;
	/** The most recent entry, or undefined if empty. O(1). */
	readonly currentEntry: TimelineYMap | undefined;
	/** Content mode of the current entry, or undefined if empty. */
	readonly currentMode: ContentMode | undefined;

	/** Read the current entry as a string. Returns '' if empty. */
	read(): string;
	/**
	 * Replace text content, wrapped in a single transaction.
	 * If current mode is text, replaces in-place. Otherwise pushes new text entry.
	 */
	write(text: string): void;

	/**
	 * Get current content as Y.Text for editor binding.
	 *
	 * If already text mode, returns the existing Y.Text. If the timeline is
	 * empty, creates a new text entry. If the current entry is a different mode,
	 * converts the content and pushes a new text entry.
	 *
	 * All conversions always succeed. Richtext→text is lossy (strips formatting).
	 */
	asText(): Y.Text;

	/**
	 * Get current content as Y.XmlFragment for richtext editor binding.
	 *
	 * If already richtext mode, returns the existing Y.XmlFragment. If empty,
	 * creates a new richtext entry. If different mode, converts and pushes.
	 */
	asRichText(): Y.XmlFragment;

	/**
	 * Get current content as sheet columns/rows for spreadsheet binding.
	 *
	 * If already sheet mode, returns existing columns and rows. If empty,
	 * creates a new sheet entry. If different mode, converts (parsed as CSV).
	 */
	asSheet(): SheetBinding;

	/** Batch mutations into a single Yjs transaction. */
	batch(fn: () => void): void;

	/**
	 * Restore this document's content to match a past snapshot.
	 *
	 * Creates a temporary Y.Doc from the snapshot binary, reads its timeline
	 * entry, and writes matching content. Mode-aware: text snapshots replace
	 * in-place (if already text) or push a new entry; sheet and richtext
	 * always push new entries.
	 *
	 * Richtext formatting (bold, italic, headings, links) is fully preserved
	 * via deep clone.
	 *
	 * The caller is responsible for saving a safety snapshot before calling this.
	 *
	 * @param snapshotBinary - Full snapshot state from `Y.encodeStateAsUpdateV2`
	 *
	 * @example
	 * ```typescript
	 * await api.saveSnapshot(docId, 'Before restore');
	 * const binary = await api.getSnapshot(docId, snapshotId);
	 * handle.restoreFromSnapshot(binary);
	 * ```
	 */
	restoreFromSnapshot(snapshotBinary: Uint8Array): void;
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

	// ── State ─────────────────────────────────────────────────────────────

	function currentEntry(): TimelineYMap | undefined {
		if (timeline.length === 0) return undefined;
		return timeline.get(timeline.length - 1);
	}

	function currentMode(): ContentMode | undefined {
		const entry = currentEntry();
		return entry ? (entry.get('type') as ContentMode) : undefined;
	}

	// ── Primitive push ops (closures, not on returned object) ─────────────

	function pushText(content: string): TextEntry {
		const entry = new Y.Map();
		entry.set('type', 'text');
		const ytext = new Y.Text();
		ytext.insert(0, content);
		entry.set('content', ytext);
		const createdAt = Date.now();
		entry.set('createdAt', createdAt);
		timeline.push([entry]);
		return { type: 'text', content: ytext, createdAt };
	}

	function pushSheet(): SheetEntry {
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
	}

	function pushRichtext(): RichTextEntry {
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
	}

	function pushSheetFromCsv(csv: string): SheetEntry {
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
	}

	function replaceCurrentText(content: string): void {
		if (currentMode() === 'text') {
			const ytext = currentEntry()!.get('content') as Y.Text;
			ytext.delete(0, ytext.length);
			ytext.insert(0, content);
		} else {
			pushText(content);
		}
	}

	function pushRichtextFromFragment(source: Y.XmlFragment): RichTextEntry {
		const result = pushRichtext();
		const children = source
			.toArray()
			.filter(
				(c): c is Y.XmlElement | Y.XmlText =>
					c instanceof Y.XmlElement || c instanceof Y.XmlText,
			)
			.map((c) => c.clone());
		result.content.insert(0, children);
		return result;
	}

	// ── Public API ────────────────────────────────────────────────────────

	return {
		get ydoc() {
			return ydoc;
		},
		get length() {
			return timeline.length;
		},
		get currentEntry() {
			return currentEntry();
		},
		get currentMode() {
			return currentMode();
		},

		read(): string {
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

		write(text: string) {
			ydoc.transact(() => replaceCurrentText(text));
		},

		asText(): Y.Text {
			const validated = readEntry(currentEntry());
			switch (validated.mode) {
				case 'text':
					return validated.content;
				case 'empty':
					return ydoc.transact(() => pushText('')).content;
				case 'richtext': {
					const plaintext = xmlFragmentToPlaintext(validated.content);
					return ydoc.transact(() => pushText(plaintext)).content;
				}
				case 'sheet': {
					const csv = serializeSheetToCsv(validated.columns, validated.rows);
					return ydoc.transact(() => pushText(csv)).content;
				}
			}
		},

		asRichText(): Y.XmlFragment {
			const validated = readEntry(currentEntry());
			switch (validated.mode) {
				case 'richtext':
					return validated.content;
				case 'empty':
					return ydoc.transact(() => pushRichtext()).content;
				case 'text': {
					const plaintext = validated.content.toString();
					return ydoc.transact(() => {
						const { content } = pushRichtext();
						populateFragmentFromText(content, plaintext);
						return { content };
					}).content;
				}
				case 'sheet': {
					const csv = serializeSheetToCsv(validated.columns, validated.rows);
					return ydoc.transact(() => {
						const { content } = pushRichtext();
						populateFragmentFromText(content, csv);
						return { content };
					}).content;
				}
			}
		},

		asSheet(): SheetBinding {
			const validated = readEntry(currentEntry());
			switch (validated.mode) {
				case 'sheet':
					return { columns: validated.columns, rows: validated.rows };
				case 'empty':
					return ydoc.transact(() => pushSheet());
				case 'text': {
					const plaintext = validated.content.toString();
					return ydoc.transact(() => pushSheetFromCsv(plaintext));
				}
				case 'richtext': {
					const plaintext = xmlFragmentToPlaintext(validated.content);
					return ydoc.transact(() => pushSheetFromCsv(plaintext));
				}
			}
		},

		batch(fn: () => void) {
			ydoc.transact(fn);
		},

		restoreFromSnapshot(snapshotBinary: Uint8Array): void {
			const tempDoc = new Y.Doc({ gc: false });
			try {
				Y.applyUpdateV2(tempDoc, snapshotBinary);

				const snapshotTl = createTimeline(tempDoc);
				const entry = readEntry(snapshotTl.currentEntry);

				switch (entry.mode) {
					case 'text': {
						const text = entry.content.toString();
						ydoc.transact(() => replaceCurrentText(text));
						break;
					}
					case 'sheet': {
						const csv = serializeSheetToCsv(entry.columns, entry.rows);
						ydoc.transact(() => pushSheetFromCsv(csv));
						break;
					}
					case 'richtext': {
						ydoc.transact(() => pushRichtextFromFragment(entry.content));
						break;
					}
					case 'empty':
						break;
				}
			} finally {
				tempDoc.destroy();
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
