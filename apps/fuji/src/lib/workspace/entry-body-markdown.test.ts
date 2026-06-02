/**
 * Tests for the faithful read-only markdown serialization of entry bodies.
 *
 * Each case builds a ProseMirror doc with `entryBodySchema`, loads it into a
 * fresh Yjs XmlFragment via `prosemirrorToYXmlFragment`, then serializes that
 * fragment back to markdown the way the daemon materializer does.
 */

import { describe, expect, test } from 'bun:test';
import type { Node } from 'prosemirror-model';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import * as Y from 'yjs';
import { serializeEntryBody } from './entry-body-markdown.js';
import { entryBodySchema as schema } from './entry-body-schema.js';

/** Serialize a ProseMirror doc node through a real Yjs fragment round trip. */
function serialize(doc: Node): string {
	const fragment = new Y.Doc().getXmlFragment('content');
	prosemirrorToYXmlFragment(doc, fragment);
	return serializeEntryBody(fragment);
}

const { nodes, marks } = schema;

function paragraph(...content: Node[]): Node {
	return nodes.paragraph!.create(null, content);
}

function doc(...content: Node[]): Node {
	return nodes.doc!.create(null, content);
}

describe('serializeEntryBody', () => {
	test('renders a heading', () => {
		const node = doc(
			nodes.heading!.create({ level: 2 }, schema.text('Title')),
		);
		expect(serialize(node)).toBe('## Title');
	});

	test('renders strong and em marks', () => {
		const node = doc(
			paragraph(
				schema.text('bold', [marks.strong!.create()]),
				schema.text(' and '),
				schema.text('italic', [marks.em!.create()]),
			),
		);
		expect(serialize(node)).toBe('**bold** and *italic*');
	});

	test('renders the underline mark as <u> html', () => {
		const node = doc(
			paragraph(schema.text('underlined', [marks.underline!.create()])),
		);
		expect(serialize(node)).toBe('<u>underlined</u>');
	});

	test('renders the strikethrough mark as ~~', () => {
		const node = doc(
			paragraph(schema.text('gone', [marks.strikethrough!.create()])),
		);
		expect(serialize(node)).toBe('~~gone~~');
	});

	test('renders a bullet list', () => {
		const item = (text: string) =>
			nodes.list_item!.create(null, paragraph(schema.text(text)));
		const node = doc(
			nodes.bullet_list!.create(null, [item('first'), item('second')]),
		);
		const md = serialize(node);
		expect(md).toContain('* first');
		expect(md).toContain('* second');
	});

	test('renders an ordered list', () => {
		const item = (text: string) =>
			nodes.list_item!.create(null, paragraph(schema.text(text)));
		const node = doc(
			nodes.ordered_list!.create({ order: 1 }, [item('one'), item('two')]),
		);
		const md = serialize(node);
		expect(md).toContain('1. one');
		expect(md).toContain('2. two');
	});

	test('renders a blockquote', () => {
		const node = doc(
			nodes.blockquote!.create(null, paragraph(schema.text('quoted'))),
		);
		expect(serialize(node)).toBe('> quoted');
	});

	test('renders a code block', () => {
		const node = doc(
			nodes.code_block!.create(null, schema.text('const x = 1;')),
		);
		expect(serialize(node)).toBe('```\nconst x = 1;\n```');
	});

	test('serializes an empty body to an empty string', () => {
		const node = doc(paragraph());
		expect(serialize(node)).toBe('');
	});
});
