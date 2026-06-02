/**
 * Tests for the faithful markdown codec for entry bodies.
 *
 * The serialize cases build a ProseMirror doc with `entryBodySchema`, load it
 * into a fresh Yjs XmlFragment via `prosemirrorToYXmlFragment`, then serialize
 * that fragment back to markdown the way the daemon materializer does. The
 * round-trip cases prove the parser is the serializer's inverse: re-serializing
 * a parsed body reproduces the original markdown (a fixed point), the gate that
 * makes body import safe.
 */

import { describe, expect, test } from 'bun:test';
import type { Node } from 'prosemirror-model';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { parseEntryBody, serializeEntryBody } from './entry-body-markdown.js';
import { entryBodySchema as schema } from './entry-body-schema.js';

/** Serialize a ProseMirror doc node through a real Yjs fragment round trip. */
function serialize(doc: Node): string {
	const fragment = new Y.Doc().getXmlFragment('content');
	prosemirrorToYXmlFragment(doc, fragment);
	return serializeEntryBody(fragment);
}

// `schema.node(name, ...)` / `schema.mark(name)` avoid indexing `schema.nodes`,
// which is `NodeType | undefined` under noUncheckedIndexedAccess.
const doc = (...content: Node[]): Node => schema.node('doc', null, content);
const paragraph = (...content: Node[]): Node =>
	schema.node('paragraph', null, content);

describe('serializeEntryBody', () => {
	test('renders a heading', () => {
		const node = doc(
			schema.node('heading', { level: 2 }, schema.text('Title')),
		);
		expect(serialize(node)).toBe('## Title');
	});

	test('renders strong and em marks', () => {
		const node = doc(
			paragraph(
				schema.text('bold', [schema.mark('strong')]),
				schema.text(' and '),
				schema.text('italic', [schema.mark('em')]),
			),
		);
		expect(serialize(node)).toBe('**bold** and *italic*');
	});

	test('renders the underline mark as <u> html', () => {
		const node = doc(
			paragraph(schema.text('underlined', [schema.mark('underline')])),
		);
		expect(serialize(node)).toBe('<u>underlined</u>');
	});

	test('renders the strikethrough mark as ~~', () => {
		const node = doc(
			paragraph(schema.text('gone', [schema.mark('strikethrough')])),
		);
		expect(serialize(node)).toBe('~~gone~~');
	});

	test('renders a bullet list', () => {
		const item = (text: string) =>
			schema.node('list_item', null, paragraph(schema.text(text)));
		const node = doc(
			schema.node('bullet_list', null, [item('first'), item('second')]),
		);
		const md = serialize(node);
		expect(md).toContain('* first');
		expect(md).toContain('* second');
	});

	test('renders an ordered list', () => {
		const item = (text: string) =>
			schema.node('list_item', null, paragraph(schema.text(text)));
		const node = doc(
			schema.node('ordered_list', { order: 1 }, [item('one'), item('two')]),
		);
		const md = serialize(node);
		expect(md).toContain('1. one');
		expect(md).toContain('2. two');
	});

	test('renders a blockquote', () => {
		const node = doc(
			schema.node('blockquote', null, paragraph(schema.text('quoted'))),
		);
		expect(serialize(node)).toBe('> quoted');
	});

	test('renders a code block', () => {
		const node = doc(
			schema.node('code_block', null, schema.text('const x = 1;')),
		);
		expect(serialize(node)).toBe('```\nconst x = 1;\n```');
	});

	test('serializes an empty body to an empty string', () => {
		const node = doc(paragraph());
		expect(serialize(node)).toBe('');
	});
});

describe('parseEntryBody round trip', () => {
	// The gate for body import: re-serializing a parsed body must reproduce the
	// serializer's own output. `serialize(parse(md)) === md` for every node and
	// both custom marks (underline-as-<u> and ~~strikethrough~~), the two the
	// default CommonMark parser would otherwise drop.
	const item = (text: string, marks: ReturnType<typeof schema.mark>[] = []) =>
		schema.node('list_item', null, paragraph(schema.text(text, marks)));

	const cases: Record<string, Node> = {
		heading: doc(schema.node('heading', { level: 2 }, schema.text('Title'))),
		paragraph: doc(paragraph(schema.text('plain text'))),
		strong: doc(paragraph(schema.text('bold', [schema.mark('strong')]))),
		em: doc(paragraph(schema.text('italic', [schema.mark('em')]))),
		code: doc(paragraph(schema.text('x', [schema.mark('code')]))),
		link: doc(
			paragraph(
				schema.text('site', [schema.mark('link', { href: 'https://x.com' })]),
			),
		),
		underline: doc(paragraph(schema.text('under', [schema.mark('underline')]))),
		strikethrough: doc(
			paragraph(schema.text('gone', [schema.mark('strikethrough')])),
		),
		'bold + underline': doc(
			paragraph(
				schema.text('both', [schema.mark('strong'), schema.mark('underline')]),
			),
		),
		'underline mid-sentence': doc(
			paragraph(
				schema.text('a '),
				schema.text('b', [schema.mark('underline')]),
				schema.text(' c'),
			),
		),
		blockquote: doc(
			schema.node('blockquote', null, paragraph(schema.text('quoted'))),
		),
		code_block: doc(
			schema.node('code_block', null, schema.text('const x = 1;')),
		),
		bullet_list: doc(
			schema.node('bullet_list', null, [item('first'), item('second')]),
		),
		ordered_list: doc(
			schema.node('ordered_list', { order: 1 }, [item('one'), item('two')]),
		),
		'list item with strikethrough': doc(
			schema.node('bullet_list', null, [
				item('struck', [schema.mark('strikethrough')]),
			]),
		),
	};

	for (const [name, node] of Object.entries(cases)) {
		test(`is a fixed point: ${name}`, () => {
			const md = serialize(node);
			expect(serialize(parseEntryBody(md))).toBe(md);
		});
	}

	test('parses an empty string to an empty body', () => {
		expect(serialize(parseEntryBody(''))).toBe('');
	});

	test('drops stray inline HTML instead of throwing on import', () => {
		// A hand-edited body may contain a tag other than the serializer's own
		// `<u>`. It must not crash the import: the stray tag is dropped, its text
		// kept. (Underline `<u>` is still recovered; see the fixed-point cases.)
		expect(serialize(parseEntryBody('before <b>x</b> after'))).toBe(
			'before x after',
		);
	});
});
