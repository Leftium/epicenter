/**
 * Note Source Tests
 *
 * The rich-text view and the Source view edit one string. These tests cover
 * the functions that string goes through: deciding whether rich text may
 * edit it, writing a rich-text body back, and changing fields in place.
 *
 * Key behaviors:
 * - Parsing a source for the rich view and writing nothing leaves it byte-identical
 * - A rich edit replaces only the body and `updatedAt`
 * - Unreadable frontmatter and unsupported bodies refuse rich editing with reasons
 * - CRLF files and the blank line after frontmatter are kept
 * - List titles and previews are plain text, and draft comparison marks changed lines
 */
import { describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import { readSource } from '@epicenter/folder';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { serializeNoteBody } from './editor/markdown.js';
import { diffLines } from './line-diff.js';
import {
	applyFields,
	applyRichBody,
	bodyText,
	displayTitle,
	missingFields,
	previewText,
	richAvailability,
} from './note-source.js';

const NOW = '2026-10-02T00:00:00.000Z' as InstantString;
const SOURCE = [
	'---',
	'# kept comment',
	'title: Groceries',
	'unknown: { a: 1 }',
	'updatedAt: 2026-10-01T00:00:00.000Z',
	'---',
	'',
	'# List',
	'',
	'- [ ] milk',
	'',
].join('\n');

describe('rich availability', () => {
	test('a supported source is editable, and re-serializing its unchanged document changes no byte', () => {
		const availability = richAvailability(SOURCE);
		expect(availability.editable).toBe(true);
		if (!availability.editable) return;
		const again = applyRichBody(
			SOURCE,
			serializeNoteBody(availability.inspection.doc),
			NOW,
		);
		expect(expectOk(again).replace(NOW, '2026-10-01T00:00:00.000Z')).toBe(
			SOURCE,
		);
	});

	test('unsupported Markdown is refused with a reason', () => {
		const availability = richAvailability(
			'---\ntitle: T\n---\n<details>x</details>\n',
		);
		expect(availability).toEqual({
			editable: false,
			reasons: ['It contains HTML.'],
		});
	});

	test('unreadable frontmatter is refused with the parser’s reason', () => {
		const availability = richAvailability('---\ntitle: *missing\n---\nbody\n');
		expect(availability.editable).toBe(false);
		if (!availability.editable)
			expect(availability.reasons[0]).toContain('Unresolved alias');
		expect(richAvailability('---\ntitle: open\n').editable).toBe(false);
	});

	test('a file with no frontmatter is editable and gains none from a body edit', () => {
		expect(richAvailability('Just text\n').editable).toBe(true);
		expect(expectOk(applyRichBody('Just text\n', 'New text', NOW))).toBe(
			'New text\n',
		);
	});
});

describe('writing a rich-text body', () => {
	test('only the body and updatedAt change', () => {
		const next = expectOk(applyRichBody(SOURCE, '# List\n\n- [x] milk', NOW));
		expect(next).toBe(
			SOURCE.replace('2026-10-01T00:00:00.000Z', NOW).replace(
				'- [ ] milk',
				'- [x] milk',
			),
		);
	});

	test('CRLF line endings are kept', () => {
		const crlf = '---\r\ntitle: T\r\n---\r\n\r\none\r\n';
		const next = expectOk(applyRichBody(crlf, 'one\n\ntwo', NOW));
		expect(next).toBe('---\r\ntitle: T\r\n---\r\n\r\none\r\n\r\ntwo\r\n');
	});

	test('an emptied body keeps the blank lines after the frontmatter and nothing else', () => {
		expect(bodyText('', '\nold\n')).toBe('\n');
		expect(bodyText('new', 'old')).toBe('new\n');
	});

	test('a source whose frontmatter cannot be read is not patched', () => {
		const broken = '---\ntitle: *missing\n---\nbody\n';
		expect(expectErr(applyRichBody(broken, 'x', NOW))).toContain(
			'Unresolved alias',
		);
	});
});

describe('fields', () => {
	test('a field change leaves comments, unknown keys, and the body as written', () => {
		const next = expectOk(
			applyFields(SOURCE, { title: 'Shopping', pinned: true }),
		);
		expect(next).toBe(
			SOURCE.replace('title: Groceries', 'title: Shopping').replace(
				'updatedAt: 2026-10-01T00:00:00.000Z\n',
				'updatedAt: 2026-10-01T00:00:00.000Z\npinned: true\n',
			),
		);
		expect(readSource(next).values?.unknown).toEqual({ a: 1 });
	});

	test('missing declared fields are named, and none when the file is complete', () => {
		expect(Object.keys(missingFields(SOURCE, NOW) ?? {})).toEqual([
			'folderId',
			'pinned',
			'createdAt',
			'deletedAt',
		]);
		const complete = expectOk(applyFields(SOURCE, missingFields(SOURCE, NOW)!));
		expect(missingFields(complete, NOW)).toBeUndefined();
		expect(missingFields('---\ntitle: *missing\n---\n', NOW)).toBeUndefined();
	});
});

describe('list text', () => {
	test('previews remove Markdown markers and titles fall back to body text', () => {
		expect(
			previewText('# Title\n\n- [x] **done** item\n> quoted `code`\n'),
		).toBe('Title done item quoted code');
		expect(displayTitle('', '\n## From the body\n')).toBe('From the body');
		expect(displayTitle('Named', 'body')).toBe('Named');
		expect(displayTitle(undefined, '')).toBe('Untitled');
	});
});

describe('comparing a draft with the file', () => {
	test('lines only on one side are marked', () => {
		expect(diffLines('a\nb\nc', 'a\nB\nc\nd')).toEqual([
			{ kind: 'same', text: 'a' },
			{ kind: 'removed', text: 'b' },
			{ kind: 'added', text: 'B' },
			{ kind: 'same', text: 'c' },
			{ kind: 'added', text: 'd' },
		]);
		expect(diffLines('', 'x')).toEqual([{ kind: 'added', text: 'x' }]);
	});
});
