/**
 * Note Text Tests
 *
 * The rich-text view and the Markdown view replace one note body in the whole
 * note. These tests cover that replacement, the text a list shows, and the
 * help a note file gets while it is repaired as text.
 *
 * Key behaviors:
 * - A new body moves an existing `updatedAt` and never adds one; the same
 *   body gives back the same note
 * - Repairing a note file as text fills only the fields it lacks, as written
 *
 * See also:
 * - `editor/markdown.test.ts` for the body codec the rich-text view uses
 */
import { describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { inspectNote as inspect } from './inspect.test-support.js';
import { diffLines } from './line-diff.js';
import {
	displayTitle,
	fieldDefaults,
	previewText,
	repairFields,
	withBody,
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

describe('a new body in the whole note', () => {
	test('a changed body moves updatedAt and keeps every other field', () => {
		const note = {
			fields: { title: 'T', owner: { a: 1 }, updatedAt: 'then' },
			body: 'old\n',
		};
		expect(withBody(note, 'new\n', NOW)).toEqual({
			fields: { title: 'T', owner: { a: 1 }, updatedAt: NOW },
			body: 'new\n',
		});
	});

	test('a note without updatedAt does not get one', () => {
		const note = { fields: { title: 'T' }, body: 'old\n' };
		const next = withBody(note, 'new\n', NOW);
		expect(next).toEqual({ fields: { title: 'T' }, body: 'new\n' });
		expect(Object.hasOwn(next.fields, 'updatedAt')).toBe(false);
	});

	test('the same body is the same note', () => {
		const note = { fields: { updatedAt: 'then' }, body: 'same\n' };
		expect(withBody(note, 'same\n', NOW)).toBe(note);
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
