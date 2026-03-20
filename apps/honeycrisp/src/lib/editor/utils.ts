/**
 * Editor content extraction utilities for Honeycrisp.
 */

import type { Editor } from '@tiptap/core';

/**
 * Extract title, preview, and word count from editor content.
 *
 * Title is the first line (up to 80 chars), preview is the first 100 chars,
 * and word count is computed by splitting on whitespace. Returns zeros/empty
 * strings for empty content.
 *
 * @example
 * ```typescript
 * const { title, preview, wordCount } = extractTitleAndPreview(editor);
 * notesState.updateNoteContent({ title, preview, wordCount });
 * ```
 */
export function extractTitleAndPreview(editor: Editor): {
	title: string;
	preview: string;
	wordCount: number;
} {
	const text = editor.getText();
	const firstNewline = text.indexOf('\n');
	const firstLine = firstNewline === -1 ? text : text.slice(0, firstNewline);
	const trimmed = text.trim();
	return {
		title: firstLine.slice(0, 80).trim(),
		preview: text.slice(0, 100).trim(),
		wordCount: trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length,
	};
}
