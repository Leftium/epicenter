/**
 * Note Source Tests
 *
 * The rich-text view and the Source view edit one string. These tests cover
 * the functions that string goes through: deciding whether rich text may
 * edit it, writing a rich-text body back, and changing fields in place.
 *
 * Key behaviors:
 * - Parsing a source for the rich view and writing nothing leaves it byte-identical
 * - A rich edit replaces only the body and a valid `updatedAt`
 * - Source that does not parse, fence-less Markdown included, and
 *   unsupported bodies refuse rich editing with reasons
 * - A field with an issue does not stop the body being edited
 * - CRLF files and the blank line after frontmatter are kept
 * - A new file's source has both fences
 */
import { describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { serializeNoteBody } from './editor/markdown.js';
import { inspectNote as inspect } from './inspect.test-support.js';
import { diffLines } from './line-diff.js';
import {
	applyFields,
	applyRichBody,
	bodyText,
	displayTitle,
	fieldDefaults,
	newSource,
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
		const availability = richAvailability(SOURCE, inspect);
		expect(availability.editable).toBe(true);
		if (!availability.editable) return;
		const again = expectOk(
			applyRichBody(
				SOURCE,
				serializeNoteBody(availability.inspection.doc),
				NOW,
				inspect,
			),
		);
		expect(again.replace(NOW, '2026-10-01T00:00:00.000Z')).toBe(SOURCE);
	});

	test('unsupported Markdown is refused with a reason', () => {
		const availability = richAvailability(
			'---\ntitle: T\n---\n<details>x</details>\n',
			inspect,
		);
		expect(availability).toEqual({
			editable: false,
			reasons: ['It contains HTML.'],
		});
	});

	test('source that does not parse is refused with the parser’s reason', () => {
		const availability = richAvailability(
			'---\ntitle: *missing\n---\nbody\n',
			inspect,
		);
		expect(availability.editable).toBe(false);
		if (!availability.editable)
			expect(availability.reasons[0]).toContain('Unresolved alias');
		expect(richAvailability('---\ntitle: open\n', inspect).editable).toBe(
			false,
		);
	});

	test('Markdown with no frontmatter lines is not a body, and a body edit does not add them', () => {
		expect(richAvailability('Just text\n', inspect).editable).toBe(false);
		const refused = applyRichBody('Just text\n', 'New text', NOW, inspect);
		expect(refused.data).toBeNull();
		expect(refused.error).toContain('does not start with a --- line');
	});

	test('a field that needs fixing does not stop the body being edited', () => {
		const source = '---\ntitle: 12\npinned: maybe\n---\nbody\n';
		expect(inspect(source).issues.length).toBeGreaterThan(0);
		expect(richAvailability(source, inspect).editable).toBe(true);
		expect(applyRichBody(source, 'new', NOW, inspect).data).toBe(
			source.replace('body', 'new'),
		);
	});
});

describe('writing a rich-text body', () => {
	test('only the body and updatedAt change', () => {
		const next = expectOk(
			applyRichBody(SOURCE, '# List\n\n- [x] milk', NOW, inspect),
		);
		expect(next).toBe(
			SOURCE.replace('2026-10-01T00:00:00.000Z', NOW).replace(
				'- [ ] milk',
				'- [x] milk',
			),
		);
	});

	test('updatedAt is neither added nor overwritten when the file holds no valid one', () => {
		for (const head of ['---\ntitle: T\n---\n', '---\nupdatedAt: soon\n---\n'])
			expect(applyRichBody(`${head}one\n`, 'two', NOW, inspect).data).toBe(
				`${head}two\n`,
			);
	});

	test('CRLF line endings are kept', () => {
		const crlf = '---\r\ntitle: T\r\n---\r\n\r\none\r\n';
		const next = expectOk(applyRichBody(crlf, 'one\n\ntwo', NOW, inspect));
		expect(next).toBe('---\r\ntitle: T\r\n---\r\n\r\none\r\n\r\ntwo\r\n');
	});

	test('an emptied body keeps the blank lines after the frontmatter and nothing else', () => {
		expect(bodyText('', '\nold\n')).toBe('\n');
		expect(bodyText('new', 'old')).toBe('new\n');
	});

	test('a source that does not parse is not patched', () => {
		const broken = '---\ntitle: *missing\n---\nbody\n';
		expect(expectErr(applyRichBody(broken, 'x', NOW, inspect))).toContain(
			'Unresolved alias',
		);
		expect(expectErr(applyFields(broken, { pinned: true }))).toContain(
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
		expect(next).toContain('unknown: { a: 1 }');
	});

	test('fields with no valid value get defaults, valid ones are left, and a complete file needs none', () => {
		const content = inspect(SOURCE);
		const defaults = fieldDefaults(content, NOW);
		expect(Object.keys(defaults ?? {})).toEqual([
			'folderId',
			'pinned',
			'createdAt',
			'deletedAt',
		]);
		const complete = expectOk(applyFields(SOURCE, defaults!));
		const repaired = inspect(complete);
		expect(repaired).toMatchObject({ parseError: undefined, issues: [] });
		expect(repaired.fields.title).toBe('Groceries');
		expect(fieldDefaults(repaired, NOW)).toBeUndefined();
		// A value that does not conform counts as having no valid value.
		const invalid = inspect(complete.replace('pinned: false', 'pinned: 3'));
		expect(fieldDefaults(invalid, NOW)).toEqual({ pinned: false });
	});

	test('a new file has both fences around its fields, so it parses', () => {
		const source = expectOk(newSource({ name: 'Recipes', icon: null }));
		expect(source).toBe('---\nname: Recipes\nicon: null\n---\n');
	});
});

describe('list text', () => {
	test('a preview is plain text without Markdown markers', () => {
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
