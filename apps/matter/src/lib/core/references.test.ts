/**
 * Row-level reference validation tests.
 *
 * Exercises `resolveReferences` over in-memory folder reads. Each folder is a real
 * `readFolder` of markdown entries plus a `matter.json`, so recognition of the `x-ref`
 * marker, conformance classification, and stem resolution are all on the live path.
 *
 * Key behaviors:
 * - A value that names an existing row stem resolves with no finding.
 * - A value that names no stem is UNRESOLVED (per cell), distinct from a target table that
 *   is not loaded at all (MISSING_TARGET, once per field).
 * - Missing / optional / non-string reference cells follow existing conformance policy and
 *   never produce a reference finding.
 * - Existence is the file existing, so a target row with its own issues still resolves.
 * - Generic over any reference field and any number of folders (no hardcoded targets).
 */

import { describe, expect, test } from 'bun:test';
import { readFolder } from './folder';
import { resolveReferences, type LoadedTable } from './references';

type Entries = Parameters<typeof readFolder>[0];

function loaded(
	table: string,
	modelText: string | undefined,
	entries: Entries,
): LoadedTable {
	return { name: table, read: readFolder(entries, modelText) };
}

const pagesModel = JSON.stringify({
	fields: { title: { type: 'string' } },
});

// `page` references the `pages` table via the x-ref marker; required by default.
const adaptationsModel = JSON.stringify({
	fields: {
		title: { type: 'string' },
		page: { type: 'string', 'x-ref': 'pages' },
	},
});

const adaptationsModelOptionalPage = JSON.stringify({
	fields: {
		title: { type: 'string' },
		page: { type: 'string', 'x-ref': 'pages' },
	},
	optional: ['page'],
});

function pages(entries: Entries): LoadedTable {
	return loaded('pages', pagesModel, entries);
}

function adaptations(
	entries: Entries,
	model = adaptationsModel,
): LoadedTable {
	return loaded('adaptations', model, entries);
}

describe('resolveReferences', () => {
	test('a value naming an existing stem resolves with no finding', () => {
		const findings = resolveReferences([
			pages([{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' }]),
			adaptations([
				{
					fileName: 'a1.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
		]);

		expect(findings).toEqual([]);
	});

	test('a value naming no stem is UNRESOLVED', () => {
		const findings = resolveReferences([
			pages([{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' }]),
			adaptations([
				{ fileName: 'a1.md', content: '---\ntitle: A\npage: does-not-exist\n---' },
			]),
		]);

		expect(findings).toEqual([
			{
				kind: 'UNRESOLVED',
				table: 'adaptations',
				file: 'a1.md',
				field: 'page',
				target: 'pages',
				value: 'does-not-exist',
			},
		]);
	});

	test('a target table absent from the loaded set is MISSING_TARGET, once, with no per-row findings', () => {
		const findings = resolveReferences([
			adaptations([
				{ fileName: 'a1.md', content: '---\ntitle: A\npage: anything\n---' },
				{ fileName: 'a2.md', content: '---\ntitle: B\npage: other\n---' },
			]),
		]);

		expect(findings).toEqual([
			{
				kind: 'MISSING_TARGET',
				table: 'adaptations',
				field: 'page',
				target: 'pages',
			},
		]);
	});

	test('a missing optional reference cell produces no finding', () => {
		const findings = resolveReferences([
			pages([{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' }]),
			adaptations(
				[{ fileName: 'a1.md', content: '---\ntitle: A\n---' }],
				adaptationsModelOptionalPage,
			),
		]);

		expect(findings).toEqual([]);
	});

	test('a missing required reference cell is left to conformance, not a reference finding', () => {
		// `page` is required and absent: conformance reports MISSING_REQUIRED; the reference
		// pass adds nothing (there is no value to resolve).
		const findings = resolveReferences([
			pages([{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' }]),
			adaptations([{ fileName: 'a1.md', content: '---\ntitle: A\n---' }]),
		]);

		expect(findings).toEqual([]);
	});

	test('a non-string reference value is left to conformance (INVALID), not UNRESOLVED', () => {
		const findings = resolveReferences([
			pages([{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' }]),
			adaptations([{ fileName: 'a1.md', content: '---\ntitle: A\npage: 123\n---' }]),
		]);

		expect(findings).toEqual([]);
	});

	test('an empty-string reference value is "no reference present", not UNRESOLVED', () => {
		// `page: ""` conforms as OK (present, non-null), but it carries no pointer to resolve.
		// Referential integrity only resolves present pointers; whether empty is ALLOWED is a
		// conformance / minLength question, so this pass adds nothing.
		const findings = resolveReferences([
			pages([{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' }]),
			adaptations([{ fileName: 'a1.md', content: '---\ntitle: A\npage: ""\n---' }]),
		]);

		expect(findings).toEqual([]);
	});

	test('a target row with its own conformance issues still satisfies a reference', () => {
		// The page row is missing its required `title`, so it needs attention — but the FILE
		// exists, so the reference to its stem resolves.
		const findings = resolveReferences([
			pages([{ fileName: 'become-the-source.md', content: '---\n---' }]),
			adaptations([
				{
					fileName: 'a1.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
		]);

		expect(findings).toEqual([]);
	});

	test('an unmodeled target folder still contributes its rows as an existence set', () => {
		// `pages` has no matter.json (unmodeled raw view), but its files still exist as rows.
		const findings = resolveReferences([
			loaded('pages', undefined, [
				{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' },
			]),
			adaptations([
				{
					fileName: 'a1.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
		]);

		expect(findings).toEqual([]);
	});

	test('generic over any reference field across a multi-tier chain', () => {
		// adaptations.page -> pages, publications.adaptation -> adaptations. Nothing about the
		// validator names these tables; each target is read from its own x-ref marker.
		const publicationsModel = JSON.stringify({
			fields: {
				adaptation: { type: 'string', 'x-ref': 'adaptations' },
			},
		});

		const findings = resolveReferences([
			pages([{ fileName: 'become-the-source.md', content: '---\ntitle: X\n---' }]),
			adaptations([
				{
					fileName: 'become-the-source-thread.md',
					content: '---\ntitle: A\npage: become-the-source\n---',
				},
			]),
			loaded('publications', publicationsModel, [
				{
					fileName: 'p-ok.md',
					content: '---\nadaptation: become-the-source-thread\n---',
				},
				{
					fileName: 'p-dangling.md',
					content: '---\nadaptation: become-the-source-carousel\n---',
				},
			]),
		]);

		expect(findings).toEqual([
			{
				kind: 'UNRESOLVED',
				table: 'publications',
				file: 'p-dangling.md',
				field: 'adaptation',
				target: 'adaptations',
				value: 'become-the-source-carousel',
			},
		]);
	});
});
