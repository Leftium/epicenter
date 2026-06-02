/**
 * Faithful, read-only markdown serialization of a fuji entry body.
 *
 * Reads an entry's rich-text Yjs fragment as a ProseMirror doc and serializes
 * it to markdown that preserves headings, lists, blockquotes, code blocks, and
 * marks (instead of flattening to plaintext). Read half only: there is no
 * markdown parser or body import here.
 */

import { defaultMarkdownSerializer, MarkdownSerializer } from 'prosemirror-markdown';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type * as Y from 'yjs';
import { entryBodySchema } from './entry-body-schema';

// defaultMarkdownSerializer covers schema-basic + schema-list nodes/marks
// (paragraph, heading, blockquote, code_block, lists, em, strong, link, code,
// image, hard_break). Extend the marks with fuji's two custom marks. Underline
// has no CommonMark form, so render it as the <u> HTML the editor already emits.
const serializer = new MarkdownSerializer(defaultMarkdownSerializer.nodes, {
	...defaultMarkdownSerializer.marks,
	strikethrough: {
		open: '~~',
		close: '~~',
		mixable: true,
		expelEnclosingWhitespace: true,
	},
	underline: { open: '<u>', close: '</u>', mixable: true },
});

export function serializeEntryBody(fragment: Y.XmlFragment): string {
	return serializer.serialize(
		yXmlFragmentToProseMirrorRootNode(fragment, entryBodySchema),
	);
}
