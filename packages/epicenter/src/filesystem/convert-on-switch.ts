import * as Y from 'yjs';
import {
	parseFrontmatter,
	serializeMarkdownWithFrontmatter,
	serializeXmlFragmentToMarkdown,
	updateYMapFromRecord,
	updateYXmlFragmentFromString,
	yMapToRecord,
} from './markdown-helpers.js';

export type ExtensionCategory = 'text' | 'richtext';

/** Determine the content category based on file extension */
export function getExtensionCategory(fileName: string): ExtensionCategory {
	return fileName.endsWith('.md') ? 'richtext' : 'text';
}

/**
 * Convert content between text and richtext representations within a Y.Doc.
 * Reads from the currently populated type and writes to the target type.
 *
 * text → richtext: Y.Text('text') → parse → Y.XmlFragment('richtext') + Y.Map('frontmatter')
 * richtext → text: Y.XmlFragment('richtext') + Y.Map('frontmatter') → serialize → Y.Text('text')
 */
export function convertContentType(
	ydoc: Y.Doc,
	from: ExtensionCategory,
	to: ExtensionCategory,
): void {
	if (from === to) return;

	if (from === 'text' && to === 'richtext') {
		const text = ydoc.getText('text').toString();
		const { frontmatter, body } = parseFrontmatter(text);
		updateYMapFromRecord(ydoc.getMap('frontmatter'), frontmatter);
		updateYXmlFragmentFromString(ydoc.getXmlFragment('richtext'), body);
	} else {
		// richtext → text
		const frontmatter = yMapToRecord(ydoc.getMap('frontmatter'));
		const body = serializeXmlFragmentToMarkdown(ydoc.getXmlFragment('richtext'));
		const combined = serializeMarkdownWithFrontmatter(frontmatter, body);
		const ytext = ydoc.getText('text');
		ydoc.transact(() => {
			ytext.delete(0, ytext.length);
			ytext.insert(0, combined);
		});
	}
}

/**
 * Self-healing: detect mismatch between file extension and populated content.
 * If the active type for the extension is empty but the other type has content,
 * run the conversion automatically.
 *
 * Called during openDocument/acquire to recover from crashed mid-migrations.
 */
export function healContentType(ydoc: Y.Doc, fileName: string): void {
	const expected = getExtensionCategory(fileName);

	if (expected === 'richtext') {
		const richtext = ydoc.getXmlFragment('richtext');
		const text = ydoc.getText('text');
		// Extension says .md but richtext is empty while text has content → migrate
		if (richtext.length === 0 && text.length > 0) {
			convertContentType(ydoc, 'text', 'richtext');
		}
	} else {
		const text = ydoc.getText('text');
		const richtext = ydoc.getXmlFragment('richtext');
		// Extension says non-.md but text is empty while richtext has content → migrate
		if (text.length === 0 && richtext.length > 0) {
			convertContentType(ydoc, 'richtext', 'text');
		}
	}
}
