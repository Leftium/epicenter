/**
 * Faithful markdown codec for a fuji entry body: serialize (read) and parse
 * (write), inverse halves that share `entryBodySchema` so they cannot drift.
 *
 * Serialize reads an entry's rich-text Yjs fragment as a ProseMirror doc and
 * writes markdown that preserves headings, lists, blockquotes, code blocks, and
 * marks (instead of flattening to plaintext). Parse is the inverse: markdown
 * back to a ProseMirror doc, so an edited `.md` body can be reconciled into the
 * content doc. The round trip is a fixed point on the serializer's own output
 * (`entry-body-markdown.test.ts` proves it for every node and both custom marks).
 */

import MarkdownIt from 'markdown-it';
import {
	defaultMarkdownParser,
	defaultMarkdownSerializer,
	MarkdownParser,
	MarkdownSerializer,
} from 'prosemirror-markdown';
import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type * as Y from 'yjs';
import { entryBodySchema } from './entry-body-schema';

// ════════════════════════════════════════════════════════════════════════════
// Serialize: ProseMirror -> markdown (the read half)
// ════════════════════════════════════════════════════════════════════════════

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

// ════════════════════════════════════════════════════════════════════════════
// Parse: markdown -> ProseMirror (the write half), the exact inverse
// ════════════════════════════════════════════════════════════════════════════

/**
 * A CommonMark tokenizer with the two extensions the serializer emits:
 * strikethrough (`~~...~~`) and inline HTML so `<u>...</u>` survives tokenizing.
 * markdown-it has no underline token, so a core rule rewrites the `<u>`/`</u>`
 * `html_inline` tokens into paired `underline_open`/`underline_close` tokens the
 * parser maps to the mark. `html: true` is safe here: the only inline HTML the
 * serializer produces is `<u>`; any other hand-authored inline HTML normalizes
 * on first apply (the round trip is guaranteed on canonical output, not arbitrary
 * input).
 */
function createEntryBodyTokenizer(): MarkdownIt {
	const md = MarkdownIt('commonmark', { html: true }).enable('strikethrough');

	md.core.ruler.push('underline_html', (state) => {
		for (const blockToken of state.tokens) {
			if (blockToken.type !== 'inline' || !blockToken.children) continue;
			const children = blockToken.children;
			for (let i = 0; i < children.length; i++) {
				const token = children[i];
				if (!token || token.type !== 'html_inline') continue;
				const tag = token.content.toLowerCase().replace(/\s+/g, '');
				if (tag === '<u>') {
					children[i] = new state.Token('underline_open', 'u', 1);
				} else if (tag === '</u>') {
					children[i] = new state.Token('underline_close', 'u', -1);
				}
			}
		}
		return true;
	});

	return md;
}

// defaultMarkdownParser.tokens covers schema-basic + list nodes/marks. Add the
// two custom marks: markdown-it emits `s_open`/`s_close` for strikethrough, and
// the core rule above emits `underline_open`/`underline_close`.
const parser = new MarkdownParser(entryBodySchema, createEntryBodyTokenizer(), {
	...defaultMarkdownParser.tokens,
	s: { mark: 'strikethrough' },
	underline: { mark: 'underline' },
});

export function parseEntryBody(markdown: string): ProseMirrorNode {
	return parser.parse(markdown);
}
