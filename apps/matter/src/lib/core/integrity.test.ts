/**
 * Composed integrity tests.
 *
 * Exercises `assess` over in-memory tables built from real `readFolder` reads, so model
 * recognition, conformance classification, and reference resolution are all on the live path.
 * The two axes under test:
 *
 *   - Every `AssessedCell` state: the four conformance states widen through unchanged
 *     (`ok` / `missing-required` / `missing-optional` / `invalid`), and a reference OK refines
 *     into the cross-table verdict (`resolved` / `dangling` / `missing-target`).
 *   - Every `TableAssessment` state: `modeled`, `unmodeled`, `invalid-contract`, `unreadable`,
 *     plus the causal chain where an absent or unreadable target table turns inbound references
 *     into `missing-target`.
 */

import { describe, expect, test } from 'bun:test';
import { readFolder } from './folder';
import {
	type AssessedCell,
	assess,
	type RowAssessment,
	type TableInput,
	type VaultIntegrity,
} from './integrity';

type Entries = Parameters<typeof readFolder>[0];

function loaded(
	name: string,
	modelText: string | undefined,
	entries: Entries,
): TableInput {
	return { name, status: 'readable', read: readFolder(entries, modelText) };
}

// `title` required, `subtitle` optional: enough to produce every conformance state.
const pagesModel = JSON.stringify({
	fields: {
		title: { type: 'string' },
		subtitle: { type: 'string' },
	},
	optional: ['subtitle'],
});

// `page` references the `pages` table via the x-ref marker; required by default.
const adaptationsModel = JSON.stringify({
	fields: {
		title: { type: 'string' },
		page: { type: 'string', 'x-ref': 'pages' },
	},
});

function modeled(v: VaultIntegrity, name: string) {
	const table = v.tables.find((t) => t.name === name);
	if (table?.status !== 'modeled') {
		throw new Error(`expected ${name} modeled, got ${table?.status}`);
	}
	return table;
}

function cellOf(row: RowAssessment, fieldName: string): AssessedCell {
	const cell = row.cells.find((c) => c.field.name === fieldName);
	if (!cell) throw new Error(`no cell for ${fieldName}`);
	return cell;
}

describe('assess: cell states', () => {
	test('a present, valid non-reference value is ok', () => {
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'p1.md', content: '---\ntitle: Hello\n---' },
			]),
		]);

		expect(cellOf(modeled(v, 'pages').rows[0]!, 'title')).toEqual({
			field: expect.objectContaining({ name: 'title' }),
			state: 'ok',
			value: 'Hello',
		});
	});

	test('an absent required cell is missing-required', () => {
		const v = assess([
			loaded('pages', pagesModel, [{ fileName: 'p1.md', content: '---\n---' }]),
		]);

		expect(cellOf(modeled(v, 'pages').rows[0]!, 'title').state).toBe(
			'missing-required',
		);
	});

	test('an absent optional cell is missing-optional', () => {
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'p1.md', content: '---\ntitle: Hello\n---' },
			]),
		]);

		expect(cellOf(modeled(v, 'pages').rows[0]!, 'subtitle').state).toBe(
			'missing-optional',
		);
	});

	test('a present value out of its field domain is invalid, carrying raw', () => {
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'p1.md', content: '---\ntitle: 123\n---' },
			]),
		]);

		expect(cellOf(modeled(v, 'pages').rows[0]!, 'title')).toEqual({
			field: expect.objectContaining({ name: 'title' }),
			state: 'invalid',
			raw: 123,
		});
	});

	test('a reference value naming an existing stem is resolved, carrying the target row', () => {
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
			]),
			loaded('adaptations', adaptationsModel, [
				{
					fileName: 'a1.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
		]);

		const cell = cellOf(modeled(v, 'adaptations').rows[0]!, 'page');
		expect(cell.state).toBe('resolved');
		if (cell.state !== 'resolved') throw new Error('unreachable');
		expect(cell.value).toBe('become-the-source');
		expect(cell.target).toBe('pages');
		expect(cell.targetRow.fileName).toBe('become-the-source.md');
	});

	test('a reference value resolving against an unmodeled target is still resolved', () => {
		// fork 2: an unmodeled folder is a valid reference target; its file stems still exist.
		const v = assess([
			loaded('pages', undefined, [
				{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
			]),
			loaded('adaptations', adaptationsModel, [
				{
					fileName: 'a1.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
		]);

		expect(cellOf(modeled(v, 'adaptations').rows[0]!, 'page').state).toBe(
			'resolved',
		);
	});

	test('a reference value naming no stem in a loaded target is dangling', () => {
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
			]),
			loaded('adaptations', adaptationsModel, [
				{ fileName: 'a1.md', content: '---\ntitle: A\npage: ghost\n---' },
			]),
		]);

		const cell = cellOf(modeled(v, 'adaptations').rows[0]!, 'page');
		expect(cell).toEqual({
			field: expect.objectContaining({ name: 'page' }),
			state: 'dangling',
			value: 'ghost',
			target: 'pages',
		});
	});

	test('a reference whose target table is absent is missing-target', () => {
		const v = assess([
			loaded('adaptations', adaptationsModel, [
				{
					fileName: 'a1.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
		]);

		const cell = cellOf(modeled(v, 'adaptations').rows[0]!, 'page');
		expect(cell).toEqual({
			field: expect.objectContaining({ name: 'page' }),
			state: 'missing-target',
			value: 'become-the-source',
			target: 'pages',
		});
	});

	test('a table that is both a reference source and a reference target classifies both roles', () => {
		// adaptations references pages AND is referenced by publications. Its own `page` column must
		// resolve while it simultaneously serves as a valid target, so the dual role does not key
		// the wrong table in the index.
		const publicationsModel = JSON.stringify({
			fields: { adaptation: { type: 'string', 'x-ref': 'adaptations' } },
		});
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
			]),
			loaded('adaptations', adaptationsModel, [
				{
					fileName: 'a1.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
			loaded('publications', publicationsModel, [
				{ fileName: 'p-ok.md', content: '---\nadaptation: a1\n---' },
				{ fileName: 'p-bad.md', content: '---\nadaptation: ghost\n---' },
			]),
		]);

		// adaptations resolves into pages (it is a source).
		expect(cellOf(modeled(v, 'adaptations').rows[0]!, 'page').state).toBe(
			'resolved',
		);
		// publications resolves into adaptations (it is a target), and the bad one dangles.
		const pubs = modeled(v, 'publications');
		expect(cellOf(pubs.rows[0]!, 'adaptation').state).toBe('resolved');
		expect(cellOf(pubs.rows[1]!, 'adaptation').state).toBe('dangling');
	});

	test('an empty-string reference is invalid: "" names no row, so it is not a valid pointer', () => {
		// The reference contract floors the value at non-empty, so `page: ""` fails the field check
		// and conformance classifies it INVALID. It never reaches the reference refinement, which
		// keeps `ok` exclusive to non-references (no empty-pointer corner).
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
			]),
			loaded('adaptations', adaptationsModel, [
				{ fileName: 'a1.md', content: '---\ntitle: A\npage: ""\n---' },
			]),
		]);

		expect(cellOf(modeled(v, 'adaptations').rows[0]!, 'page')).toEqual({
			field: expect.objectContaining({ name: 'page' }),
			state: 'invalid',
			raw: '',
		});
	});
});

describe('assess: table states', () => {
	test('a folder with a usable model is modeled, carrying its rows and model', () => {
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'p1.md', content: '---\ntitle: Hello\n---' },
			]),
		]);

		const pages = modeled(v, 'pages');
		expect(pages.rows).toHaveLength(1);
		expect(pages.model.fields.map((f) => f.name)).toEqual(['title', 'subtitle']);
	});

	test('a modeled row surfaces frontmatter keys outside the contract as extras', () => {
		const v = assess([
			loaded('pages', pagesModel, [
				{ fileName: 'p1.md', content: '---\ntitle: Hello\nstray: kept\n---' },
			]),
		]);

		expect(modeled(v, 'pages').rows[0]!.extras).toEqual([
			{ key: 'stray', value: 'kept' },
		]);
	});

	test('a folder with no matter.json is unmodeled, a valid raw grid', () => {
		const v = assess([
			loaded('notes', undefined, [
				{ fileName: 'n1.md', content: '---\ntag: idea\n---' },
			]),
		]);

		const table = v.tables[0]!;
		expect(table.status).toBe('unmodeled');
		if (table.status !== 'unmodeled') throw new Error('unreachable');
		expect(table.rows).toHaveLength(1);
		expect(table.columns).toEqual(['tag']);
	});

	test('a folder with a corrupt matter.json is invalid-contract, carrying a message', () => {
		const v = assess([
			loaded('pages', '{ not valid json', [
				{ fileName: 'p1.md', content: '---\ntitle: Hello\n---' },
			]),
		]);

		const table = v.tables[0]!;
		expect(table.status).toBe('invalid-contract');
		if (table.status !== 'invalid-contract') throw new Error('unreachable');
		expect(table.message.length).toBeGreaterThan(0);
	});

	test('a folder that could not be read is unreadable, carrying its message', () => {
		const input: TableInput = {
			name: 'pages',
			status: 'unreadable',
			message: 'permission denied',
		};
		const v = assess([input]);

		expect(v.tables[0]).toEqual({
			name: 'pages',
			status: 'unreadable',
			message: 'permission denied',
		});
	});
});

describe('assess: the missing-target causal chain', () => {
	test('an unreadable target table turns inbound references into missing-target', () => {
		// pages cannot be read, so it contributes no stems; adaptations.page has nowhere to
		// resolve and the whole column reports missing-target, while pages itself is unreadable.
		const v = assess([
			{ name: 'pages', status: 'unreadable', message: 'permission denied' },
			loaded('adaptations', adaptationsModel, [
				{
					fileName: 'a1.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
		]);

		expect(v.tables.find((t) => t.name === 'pages')?.status).toBe('unreadable');
		expect(cellOf(modeled(v, 'adaptations').rows[0]!, 'page').state).toBe(
			'missing-target',
		);
	});
});
