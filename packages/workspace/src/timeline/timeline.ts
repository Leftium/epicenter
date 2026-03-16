import * as Y from 'yjs';
import {
	populateFragmentFromText,
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

/** The result of binding a sheet—columns and rows Y.Maps. */
export type SheetBinding = {
	columns: Y.Map<Y.Map<string>>;
	rows: Y.Map<Y.Map<string>>;
};
export type TimelineEntry = TextEntry | RichTextEntry | SheetEntry;

/** Content types supported by timeline entries. */
export type ContentType = TimelineEntry['type'];

export type Timeline = {
	/** The Y.Doc this timeline is bound to. */
	readonly ydoc: Y.Doc;
	/** Number of entries in the timeline. */
	readonly length: number;
	/**
	 * The current (last) entry, validated and typed. Returns `null` if no entries exist.
	 *
	 * Recomputed on every access—each call parses the underlying Y.Map and
	 * returns a fresh object. Do not rely on reference equality between calls.
	 */
	readonly currentEntry: TimelineEntry | null;
	/** Content type of the current entry, or undefined if empty. */
	readonly currentType: ContentType | undefined;

	/**
	 * Read the current entry as a plain string. Returns `''` if empty.
	 *
	 * Conversion is type-dependent: text returns as-is, richtext strips all
	 * formatting (lossy), and sheet serializes to CSV.
	 */
	read(): string;
	/**
	 * Write string content to the current mode, wrapped in a single transaction.
	 *
	 * Mode-aware: text replaces Y.Text in-place, sheet parses CSV and replaces
	 * columns/rows in-place, richtext clears the fragment and repopulates from
	 * plaintext. When the current type matches, no new timeline entry is created
	 * and `observe()` does **not** fire. On empty timelines, pushes a new text entry.
	 *
	 * To switch modes before writing, call `asText()`, `asSheet()`, or
	 * `asRichText()` first.
	 */
	write(text: string): void;

	/**
	 * Append text to the current entry's content, wrapped in a single transaction.
	 *
	 * If the current entry is text, inserts at the end of the existing Y.Text
	 * without creating a new timeline entry. If the timeline is empty, creates
	 * a new text entry with the content. If the current entry is a different type
	 * (richtext/sheet), reads existing content as a string, concatenates, and
	 * replaces as text.
	 */
	appendText(text: string): void;

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
	 * Does **not** fire when `write()` replaces content in-place (same type).
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
 *   if (entry?.type === 'richtext') rebindEditor(entry.content);
	 * });
	 * // later: unsub();
	 * ```
	 */
	observe(callback: () => void): () => void;
};


export function createTimeline(ydoc: Y.Doc): Timeline {
	const timeline = ydoc.getArray<TimelineYMap>('timeline');

	// ── State ─────────────────────────────────────────────────────────────

	function lastEntry(): TimelineYMap | undefined {
		if (timeline.length === 0) return undefined;
		return timeline.get(timeline.length - 1);
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
	/**
	 * Replace text in-place if already text type, otherwise push a new text entry.
	 *
	 * Shared by `write()` and `restoreFromSnapshot()` so that restoring text
	 * content looks identical to a user paste—no unnecessary timeline growth
	 * when the type hasn't changed.
	 */
	function replaceCurrentText(content: string): void {
		const entry = lastEntry();
		if (entry?.get('type') === 'text') {
			// Same mode: overwrite the existing Y.Text (select-all + paste equivalent).
			// No new timeline entry—the observer does NOT fire.
			const ytext = entry.get('content') as Y.Text;
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

	/**
	 * Push a new sheet entry whose columns and rows are deep-cloned from a source sheet.
	 *
	 * `Y.Map.clone()` produces an unattached deep copy that preserves all column
	 * metadata (name, kind, width, order) and all row data (cell values, order).
	 * Column and row IDs are preserved so cell references (row cells keyed by
	 * column ID) remain valid in the cloned entry.
	 *
	 * This avoids the lossy CSV round-trip used by `parseSheetFromCsv`, which
	 * hardcodes column `kind` to `'text'` and `width` to `'120'`—dropping any
	 * custom column configuration the snapshot had.
	 *
	 * Used by `restoreFromSnapshot()` for sheet type.
	 */
	function pushSheetFromSnapshot(
		sourceColumns: Y.Map<Y.Map<string>>,
		sourceRows: Y.Map<Y.Map<string>>,
	): SheetEntry {
		const entry = new Y.Map();
		entry.set('type', 'sheet');
		const columns = sourceColumns.clone();
		const rows = sourceRows.clone();
		entry.set('columns', columns);
		entry.set('rows', rows);
		const createdAt = Date.now();
		entry.set('createdAt', createdAt);
		timeline.push([entry]);
		return { type: 'sheet', columns, rows, createdAt };
	}

	// ── Public API ────────────────────────────────────────────────────────

	return {
		get ydoc() {
			return ydoc;
		},
		get length() {
			return timeline.length;
		},
		get currentEntry(): TimelineEntry | null {
			return readEntry(lastEntry());
		},
		get currentType() {
			const entry = lastEntry();
			return entry ? (entry.get('type') as ContentType) : undefined;
		},

		read(): string {
			const entry = this.currentEntry;
			if (!entry) return '';
			switch (entry.type) {
				case 'text':
					return entry.content.toString();
				case 'richtext':
					return xmlFragmentToPlaintext(entry.content);
				case 'sheet':
					return serializeSheetToCsv(entry.columns, entry.rows);
			}
		},

		write(text: string) {
			ydoc.transact(() => {
				const type = this.currentType;
				// Sheet: clear columns/rows and repopulate from CSV
				if (type === 'sheet') {
					const entry = lastEntry()!;
					const columns = entry.get('columns') as Y.Map<Y.Map<string>>;
					const rows = entry.get('rows') as Y.Map<Y.Map<string>>;
					columns.forEach((_, key) => columns.delete(key));
					rows.forEach((_, key) => rows.delete(key));
					parseSheetFromCsv(text, columns, rows);
				// Richtext: clear fragment and repopulate as paragraphs
				} else if (type === 'richtext') {
					const fragment = lastEntry()!.get('content') as Y.XmlFragment;
					fragment.delete(0, fragment.length);
					populateFragmentFromText(fragment, text);
				// Text (or empty): delegate to replaceCurrentText
				} else {
					replaceCurrentText(text);
				}
			});
		},

		appendText(text: string) {
			ydoc.transact(() => {
				const entry = this.currentEntry;
				if (!entry) {
					pushText(text);
					return;
				}
				if (entry.type === 'text') {
					entry.content.insert(entry.content.length, text);
				} else {
					const existing = entry.type === 'richtext'
						? xmlFragmentToPlaintext(entry.content)
						: serializeSheetToCsv(entry.columns, entry.rows);
					replaceCurrentText(existing + text);
				}
			});
		},

		asText(): Y.Text {
			const entry = this.currentEntry;
			if (!entry) return ydoc.transact(() => pushText('')).content;
			switch (entry.type) {
				case 'text':
					return entry.content;
				case 'richtext': {
					const plaintext = xmlFragmentToPlaintext(entry.content);
					return ydoc.transact(() => pushText(plaintext)).content;
				}
				case 'sheet': {
					const csv = serializeSheetToCsv(entry.columns, entry.rows);
					return ydoc.transact(() => pushText(csv)).content;
				}
			}
		},

		asRichText(): Y.XmlFragment {
			const entry = this.currentEntry;
			if (!entry) return ydoc.transact(() => pushRichtext()).content;
			switch (entry.type) {
				case 'richtext':
					return entry.content;
				case 'text': {
					const plaintext = entry.content.toString();
					return ydoc.transact(() => {
						const { content } = pushRichtext();
						populateFragmentFromText(content, plaintext);
						return { content };
					}).content;
				}
				case 'sheet': {
					const csv = serializeSheetToCsv(entry.columns, entry.rows);
					return ydoc.transact(() => {
						const { content } = pushRichtext();
						populateFragmentFromText(content, csv);
						return { content };
					}).content;
				}
			}
		},

		asSheet(): SheetBinding {
			const entry = this.currentEntry;
			if (!entry) return ydoc.transact(() => pushSheet());
			switch (entry.type) {
				case 'sheet':
					return { columns: entry.columns, rows: entry.rows };
				case 'text': {
					const plaintext = entry.content.toString();
					return ydoc.transact(() => {
						const result = pushSheet();
						parseSheetFromCsv(plaintext, result.columns, result.rows);
						return result;
					});
				}
				case 'richtext': {
					const plaintext = xmlFragmentToPlaintext(entry.content);
					return ydoc.transact(() => {
						const result = pushSheet();
						parseSheetFromCsv(plaintext, result.columns, result.rows);
						return result;
					});
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
				// what content type (text/sheet/richtext) the snapshot was in
				// and gives access to the snapshot's CRDT content types.
				const snapshotTl = createTimeline(tempDoc);
				const entry = snapshotTl.currentEntry;

				// Snapshot had no timeline entries (e.g., pre-migration doc). No-op.
				if (!entry) return;

				// ── Step 3: Write ──────────────────────────────────────────────
				// Create new forward CRDT operations on the live doc that make
				// visible content match the snapshot. Each type extracts content
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
						// Deep-clone preserves all column metadata (kind, width, order, name)
						// and row data. Always pushes a new entry.
						ydoc.transact(() =>
							pushSheetFromSnapshot(entry.columns, entry.rows),
						);
						break;
					}
					case 'richtext': {
						// Deep-clone preserves all formatting (bold, headings, links).
						// Always pushes a new entry—no in-place for richtext.
						ydoc.transact(() => pushRichtextFromFragment(entry.content));
						break;
					}
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

function readEntry(entry: Y.Map<unknown> | undefined): TimelineEntry | null {
	if (!entry) return null;

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

	return null;
}
