/**
 * Note Text Tests
 *
 * The rich-text view and the Markdown view edit one note body. These tests
 * cover the functions that body goes through, and the help a note file gets
 * while it is repaired as text.
 *
 * Key behaviors:
 * - Parsing a body for the rich view and writing nothing leaves it byte-identical
 * - Unsupported bodies refuse rich editing with reasons
 * - CRLF bodies and blank lines at the start of a body are kept
 * - Repairing a note file as text fills only the fields it lacks, as written
 */
import { describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { serializeNoteBody } from './editor/markdown.js';
import { inspectNote as inspect } from './inspect.test-support.js';
import { diffLines } from './line-diff.js';
import {
	bodyText,
	displayTitle,
	fieldDefaults,
	previewText,
	repairFields,
	richAvailability,
} from './note-source.js';

const NOW = '2026-10-02T00:00:00.000Z' as InstantString;
const BODY = '\n# List\n\n- [ ] milk\n';
const SOURCE = [
	'---',
	'# kept comment',
	'title: Groceries',
	'unknown: { a: 1 }',
	'updatedAt: 2026-10-01T00:00:00.000Z',
	'---',
	BODY,
].join('\n');

describe('rich availability', () => {
	test('a supported body is editable, and re-serializing its unchanged document changes no byte', () => {
		const availability = richAvailability(BODY);
		expect(availability.editable).toBe(true);
		if (!availability.editable) return;
		expect(
			bodyText(serializeNoteBody(availability.inspection.doc), BODY),
		).toBe(BODY);
	});

	test('unsupported Markdown is refused with a reason', () => {
		expect(richAvailability('<details>x</details>\n')).toEqual({
			editable: false,
			reasons: ['It contains HTML.'],
		});
	});
});

describe('writing a rich-text body', () => {
	test('CRLF line endings are kept', () => {
		expect(bodyText('one\n\ntwo', '\r\none\r\n')).toBe('\r\none\r\n\r\ntwo\r\n');
	});

	test('an emptied body keeps the blank lines at its start and nothing else', () => {
		expect(bodyText('', '\nold\n')).toBe('\n');
		expect(bodyText('new', 'old')).toBe('new\n');
	});
});

describe('repairing a note file as text', () => {
	test('fields with no valid value get defaults, valid ones are left, and a complete file needs none', () => {
		const content = inspect(SOURCE);
		const defaults = fieldDefaults(content, NOW);
		expect(Object.keys(defaults ?? {})).toEqual([
			'folderId',
			'pinned',
			'createdAt',
			'deletedAt',
		]);
		const complete = expectOk(repairFields(SOURCE, defaults ?? {}));
		// What the person wrote stays as written.
		expect(complete).toContain('# kept comment\ntitle: Groceries\n');
		expect(complete).toContain('unknown: { a: 1 }');
		const repaired = inspect(complete);
		expect(repaired).toMatchObject({ parseError: undefined, issues: [] });
		expect(repaired.fields.title).toBe('Groceries');
		expect(fieldDefaults(repaired, NOW)).toBeUndefined();
		// A value that does not conform counts as having no valid value.
		const invalid = inspect(complete.replace('pinned: false', 'pinned: 3'));
		expect(fieldDefaults(invalid, NOW)).toEqual({ pinned: false });
	});

	test('text that does not parse is not changed', () => {
		expect(
			expectErr(repairFields('---\ntitle: *missing\n---\nbody\n', {})),
		).toContain('Unresolved alias');
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
