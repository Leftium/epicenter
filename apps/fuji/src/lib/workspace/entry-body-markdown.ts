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
 * markdown-it has no underline token, so a core rule rewrites the exact `<u>` /
 * `</u>` tokens into paired `underline_open`/`underline_close` tokens the parser
 * maps to the mark. Any OTHER inline HTML a hand-authored file might contain is
 * dropped by the parser (`html_inline: { ignore: true }` below), not errored on.
 *
 * `<u>` is the intended way to author underline by hand: CommonMark has no
 * underline syntax, so HTML is its only expression, and a `.md` may legitimately
 * contain raw HTML. So a literal `<u>...</u>` typed as prose is read back as an
 * underline mark BY DESIGN, not corruption (contrast `~~`, which the serializer
 * escapes in plain text; underline is left unescaped because round-tripping it
 * is the goal). Editor-produced and hand-authored bodies agree.
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
				if (token.content === '<u>') {
					children[i] = new state.Token('underline_open', 'u', 1);
				} else if (token.content === '</u>') {
					children[i] = new state.Token('underline_close', 'u', -1);
				}
			}
		}
		return true;
	});

	return md;
}

// defaultMarkdownParser.tokens covers schema-basic + list nodes/marks. Add the
// two custom marks (markdown-it emits `s_open`/`s_close` for strikethrough; the
// core rule above emits `underline_open`/`underline_close`), and ignore any
// other inline HTML so a stray tag in a hand-edited file is dropped, not thrown.
const parser = new MarkdownParser(entryBodySchema, createEntryBodyTokenizer(), {
	...defaultMarkdownParser.tokens,
	s: { mark: 'strikethrough' },
	underline: { mark: 'underline' },
	// html_inline is a standalone (non-paired) token, so it needs noCloseToken
	// for the ignore handler to bind to the bare type rather than _open/_close.
	html_inline: { ignore: true, noCloseToken: true },
});

export function parseEntryBody(markdown: string): ProseMirrorNode {
	return parser.parse(markdown);
}
