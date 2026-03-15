import * as Y from 'yjs';
import {
	populateFragmentFromText,
	type SheetBinding,
	xmlFragmentToPlaintext,
} from './richtext.js';
import { parseSheetFromCsv, serializeSheetToCsv } from './sheet.js';

type TimelineYMap = Y.Map<unknown>;

// ── Entry types ──────────────────────────────────────────────────────────

/**
 * Timeline entry shapes — a discriminated union on 'type'.
 * These describe the extracted, typed form of what's stored in Y.Maps.
 * At runtime, entries are Y.Map instances; push functions construct them
 * and readEntry validates/extracts them into these shapes.
 */
export type TextEntry = {
	type: 'text';
	content: Y.Text;
	createdAt: number;
};
export type RichTextEntry = {
	type: 'richtext';
	content: Y.XmlFragment;
	frontmatter: Y.Map<unknown>;
	createdAt: number;
};
export type SheetEntry = {
	type: 'sheet';
	columns: Y.Map<Y.Map<string>>;
	rows: Y.Map<Y.Map<string>>;
	createdAt: number;
};
export type TimelineEntry = TextEntry | RichTextEntry | SheetEntry;

/** Content types supported by timeline entries. */
export type ContentType = TimelineEntry['type'];

export type Timeline = {
	/** The Y.Doc this timeline is bound to. */
	readonly ydoc: Y.Doc;
	/** Number of entries in the timeline. */
	readonly length: number;
	/** The current entry, validated and typed. Returns `{ type: 'empty' }` if no entries. */
	readonly currentEntry: ValidatedEntry;
	/** Content type of the current entry, or undefined if empty. */
	readonly currentType: ContentType | undefined;

	/** Read the current entry as a string. Returns '' if empty. */
	read(): string;
	/**
	 * Replace text content, wrapped in a single transaction.
	 * If current type is text, replaces in-place. Otherwise pushes new text entry.
	 */
	write(text: string): void;

	/**
	 * Get current content as Y.Text for editor binding.
	 *
	 * If already text type, returns the existing Y.Text. If the timeline is
	 * empty, creates a new text entry. If the current entry is a different type,
	 * converts the content and pushes a new text entry.
	 *
	 * All conversions always succeed. Richtext→text is lossy (strips formatting).
	 */
	asText(): Y.Text;

	/**
	 * Get current content as Y.XmlFragment for richtext editor binding.
	 *
	 * If already richtext type, returns the existing Y.XmlFragment. If empty,
	 * creates a new richtext entry. If different type, converts and pushes.
	 */
	asRichText(): Y.XmlFragment;

	/**
	 * Get current content as sheet columns/rows for spreadsheet binding.
	 *
	 * If already sheet type, returns existing columns and rows. If empty,
	 * creates a new sheet entry. If different type, converts (parsed as CSV).
	 */
	asSheet(): SheetBinding;

	/** Batch mutations into a single Yjs transaction. */
	batch(fn: () => void): void;

	/**
	 * Restore this document's content to match a past snapshot.
	 *
	 * Creates a temporary Y.Doc from the snapshot binary, reads its timeline
	 * entry, and writes matching content. Type-aware: text snapshots replace
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

	/**
	 * Watch for structural timeline changes—entries added or removed.
	 *
	 * Fires when the entry list changes (e.g., a new entry is pushed via
	 * `write()`, `asText()`, `asRichText()`, `asSheet()`, or `restoreFromSnapshot()`).
	 * Does NOT fire when content within an existing entry changes—edits to
	 * Y.Text, Y.XmlFragment, or Y.Map are handled by those shared types directly.
	 * Editors already bind to the CRDT handle and receive updates natively.
	 *
	 * Re-read `currentEntry` in the callback to get the new state.
	 *
	 * @returns Unsubscribe function
	 *
	 * @example
	 * ```typescript
	 * const unsub = timeline.observe(() => {
	 *   const entry = timeline.currentEntry;
	 *   if (entry.type === 'richtext') rebindEditor(entry.content);
	 * });
	 * // later: unsub();
	 * ```
	 */
	observe(callback: () => void): () => void;
};

export type ValidatedEntry = TimelineEntry | { type: 'empty' };

export function createTimeline(ydoc: Y.Doc): Timeline {
	const timeline = ydoc.getArray<TimelineYMap>('timeline');

	// ── State ─────────────────────────────────────────────────────────────

	function currentEntry(): TimelineYMap | undefined {
		if (timeline.length === 0) return undefined;
		return timeline.get(timeline.length - 1);
	}

	function currentType(): ContentType | undefined {
		const entry = currentEntry();
		return entry ? (entry.get('type') as ContentType) : undefined;
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

	/**
	 * Replace text in-place if already text type, otherwise push a new text entry.
	 *
	 * Shared by `write()` and `restoreFromSnapshot()` so that restoring text
	 * content looks identical to a user paste—no unnecessary timeline growth
	 * when the type hasn't changed.
	 */
	function replaceCurrentText(content: string): void {
		if (currentType() === 'text') {
			// Same mode: overwrite the existing Y.Text (select-all + paste equivalent).
			// No new timeline entry—the observer does NOT fire.
			const ytext = currentEntry()!.get('content') as Y.Text;
			ytext.delete(0, ytext.length);
			ytext.insert(0, content);
		} else {
			// Different type (or empty): push a new text entry (type change).
			pushText(content);
		}
	}

	/**
	 * Push a new richtext entry whose content is deep-cloned from a source fragment.
	 *
	 * `Y.XmlElement.clone()` / `Y.XmlText.clone()` produce unattached copies that
	 * preserve all formatting (bold, italic, headings, links). This is how richtext
	 * content transfers between Y.Doc instances without flattening to plaintext.
	 *
	 * Used by `restoreFromSnapshot()` for richtext type.
	 */
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
		get currentEntry(): ValidatedEntry {
			return readEntry(currentEntry());
		},
		get currentType() {
			return currentType();
		},

		read(): string {
			const validated = readEntry(currentEntry());
			switch (validated.type) {
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
			switch (validated.type) {
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
			switch (validated.type) {
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
			switch (validated.type) {
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
			// ── Step 1: Hydrate ──────────────────────────────────────────────
			// Create a temporary Y.Doc and apply the snapshot binary to reconstruct
			// the full document state at snapshot time.
			const tempDoc = new Y.Doc({ gc: false });
			try {
				Y.applyUpdateV2(tempDoc, snapshotBinary);

				// ── Step 2: Read ──────────────────────────────────────────────
				// Extract the last timeline entry from the snapshot. This tells us
				// what content type (text/sheet/richtext/empty) the snapshot was in
				// and gives access to the snapshot's CRDT content types.
				const snapshotTl = createTimeline(tempDoc);
				const entry = snapshotTl.currentEntry;

				// ── Step 3: Write ──────────────────────────────────────────────
				// Create new forward CRDT operations on the live doc that make
				// visible content match the snapshot. Each mode extracts content
				// from the temp doc's types and writes it into the live doc's
				// timeline using the same helpers that write() and as*() use.
				switch (entry.type) {
					case 'text': {
						// Y.Text can't transfer between docs—extract the raw string.
						// replaceCurrentText handles same-mode (in-place) vs cross-mode (push).
						const text = entry.content.toString();
						ydoc.transact(() => replaceCurrentText(text));
						break;
					}
					case 'sheet': {
						// Sheet structure (column IDs, fractional orders) can't be reused
						// across docs. Round-trip through CSV to rebuild fresh Y.Maps.
						const csv = serializeSheetToCsv(entry.columns, entry.rows);
						ydoc.transact(() => pushSheetFromCsv(csv));
						break;
					}
					case 'richtext': {
						// Deep-clone preserves all formatting (bold, headings, links).
						// Always pushes a new entry—no in-place for richtext.
						ydoc.transact(() => pushRichtextFromFragment(entry.content));
						break;
					}
					case 'empty':
						// Snapshot had no timeline entries (e.g., pre-migration doc). No-op.
						break;
				}
			} finally {
				// Always destroy the temp doc, even if applyUpdateV2 threw on corrupted binary.
				tempDoc.destroy();
			}
		},

		observe(callback: () => void): () => void {
			const handler = () => callback();
			timeline.observe(handler);
			return () => timeline.unobserve(handler);
		},
	};
}

function readEntry(entry: Y.Map<unknown> | undefined): ValidatedEntry {
	if (!entry) return { type: 'empty' };

	const type = entry.get('type');
	const createdAt = (entry.get('createdAt') as number) ?? 0;

	if (type === 'text') {
		const content = entry.get('content');
		if (content instanceof Y.Text) return { type: 'text', content, createdAt };
	}

	if (type === 'richtext') {
		const content = entry.get('content');
		const frontmatter = entry.get('frontmatter');
		if (content instanceof Y.XmlFragment && frontmatter instanceof Y.Map) {
			return { type: 'richtext', content, frontmatter, createdAt };
		}
	}

	if (type === 'sheet') {
		const columns = entry.get('columns');
		const rows = entry.get('rows');
		if (columns instanceof Y.Map && rows instanceof Y.Map) {
			return {
				type: 'sheet',
				columns: columns as Y.Map<Y.Map<string>>,
				rows: rows as Y.Map<Y.Map<string>>,
				createdAt,
			};
		}
	}

	return { type: 'empty' };
}
