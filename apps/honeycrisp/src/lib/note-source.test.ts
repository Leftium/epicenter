/**
 * Note Text Tests
 *
 * The rich-text view and the Markdown view replace one note body in the whole
 * note. These tests cover that replacement and the text a list shows.
 *
 * Key behaviors:
 * - A new body moves an existing `updatedAt` and never adds one; the same
 *   body gives back the same note
 *
 * See also:
 * - `editor/markdown.test.ts` for the body codec the rich-text view uses
 */
import { describe, expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/definition';
import { displayTitle, previewText, withBody } from './note-source.js';

const NOW = '2026-10-02T00:00:00.000Z' as InstantString;

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
