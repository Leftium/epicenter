/**
 * Editor content extraction utilities for Honeycrisp.
 */

import type { Node } from 'prosemirror-model';

/**
 * Extract title, preview, and word count from the ProseMirror document.
 *
 * Title is the first line (up to 80 chars), preview is the first 100 chars,
 * and word count is computed by splitting on whitespace. Returns zeros/empty
 * strings for empty content.
 *
 * @example
 * ```typescript
 * const { title, preview, wordCount } = extractTitleAndPreview(view.state.doc);
 * notesState.updateNoteContent({ title, preview, wordCount });
 * ```
 */
export function extractTitleAndPreview(doc: Node): {
	title: string;
	preview: string;
	wordCount: number;
} {
	const text = doc.textContent;
	const firstNewline = text.indexOf('\n');
	const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
	const trimmed = text.trim();
	return {
		title: firstLine.slice(0, 80).trim(),
		preview: text.slice(0, 100).trim(),
		wordCount: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
	};
}
