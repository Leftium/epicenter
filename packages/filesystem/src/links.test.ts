import { describe, expect, test } from 'bun:test';
import {
	convertEntityRefsToWikilinks,
	convertWikilinksToEntityRefs,
	ENTITY_REF_RE,
	isEntityRef,
	makeEntityRef,
	parseEntityRef,
} from './links.js';

const SAMPLE_ID = '01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b';
const SAMPLE_WORKSPACE = 'opensidian';
const SAMPLE_TABLE = 'files';
const SAMPLE_REF = `epicenter://opensidian/files/${SAMPLE_ID}`;

describe('isEntityRef', () => {
	test('returns true for epicenter URIs', () => {
		expect(isEntityRef(SAMPLE_REF)).toBe(true);
	});

	test('returns false for https URLs', () => {
		expect(isEntityRef('https://example.com')).toBe(false);
	});

	test('returns false for empty strings', () => {
		expect(isEntityRef('')).toBe(false);
	});

	test('returns false for bare ids', () => {
		expect(isEntityRef(SAMPLE_ID)).toBe(false);
	});
});

describe('parseEntityRef', () => {
	test('extracts workspace, table, and id', () => {
		expect(parseEntityRef(SAMPLE_REF)).toEqual({
			workspace: SAMPLE_WORKSPACE,
			table: SAMPLE_TABLE,
			id: SAMPLE_ID,
		});
	});

	test('returns null for non-epicenter URIs', () => {
		expect(parseEntityRef('https://example.com/files/abc')).toBeNull();
	});

	test('handles dots in workspace ids', () => {
		expect(parseEntityRef('epicenter://epicenter.blog/posts/abc')).toEqual({
			workspace: 'epicenter.blog',
			table: 'posts',
			id: 'abc',
		});
	});
});

describe('makeEntityRef', () => {
	test('produces the correct URI', () => {
		expect(makeEntityRef(SAMPLE_WORKSPACE, SAMPLE_TABLE, SAMPLE_ID)).toBe(
			SAMPLE_REF,
		);
	});

	test('round-trips with parseEntityRef', () => {
		const href = makeEntityRef(SAMPLE_WORKSPACE, SAMPLE_TABLE, SAMPLE_ID);

		expect(parseEntityRef(href)).toEqual({
			workspace: SAMPLE_WORKSPACE,
			table: SAMPLE_TABLE,
			id: SAMPLE_ID,
		});
	});
});

describe('convertEntityRefsToWikilinks', () => {
	test('converts epicenter links to wikilinks', () => {
		const body = `See [Meeting Notes](${SAMPLE_REF}) for details.`;

		expect(convertEntityRefsToWikilinks(body)).toBe(
			'See [[Meeting Notes]] for details.',
		);
	});

	test('leaves external links untouched', () => {
		const body = '[Google](https://google.com)';

		expect(convertEntityRefsToWikilinks(body)).toBe(body);
	});

	test('handles mixed entity refs and external links', () => {
		const body = `[Notes](${SAMPLE_REF}) and [Google](https://google.com)`;

		expect(convertEntityRefsToWikilinks(body)).toBe(
			'[[Notes]] and [Google](https://google.com)',
		);
	});
});

describe('convertWikilinksToEntityRefs', () => {
	const resolve = (name: string) => {
		const lookup: Record<string, string> = {
			'First Note': SAMPLE_REF,
			'Project Plan': 'epicenter://opensidian/files/def-456',
		};

		return lookup[name] ?? null;
	};

	test('converts wikilinks to epicenter links', () => {
		const body = 'See [[First Note]] for details.';

		expect(convertWikilinksToEntityRefs(body, resolve)).toBe(
			`See [First Note](${SAMPLE_REF}) for details.`,
		);
	});

	test('leaves unresolved wikilinks as-is', () => {
		const body = '[[Unknown Page]]';

		expect(convertWikilinksToEntityRefs(body, resolve)).toBe(body);
	});

	test('round-trips with convertEntityRefsToWikilinks', () => {
		const original = `[First Note](${SAMPLE_REF})`;
		const asWikilink = convertEntityRefsToWikilinks(original);

		expect(asWikilink).toBe('[[First Note]]');
		expect(convertWikilinksToEntityRefs(asWikilink, resolve)).toBe(original);
	});
});

describe('ENTITY_REF_RE', () => {
	test('matches markdown entity ref links with both capture groups', () => {
		const body = `See [First Note](${SAMPLE_REF}) for details.`;
		ENTITY_REF_RE.lastIndex = 0;
		const match = ENTITY_REF_RE.exec(body);

		expect(match?.[0]).toBe(`[First Note](${SAMPLE_REF})`);
		expect(match?.[1]).toBe('First Note');
		expect(match?.[2]).toBe(SAMPLE_REF);

		ENTITY_REF_RE.lastIndex = 0;
	});

	test('does not match external links', () => {
		ENTITY_REF_RE.lastIndex = 0;
		const match = ENTITY_REF_RE.exec('[First Note](https://example.com)');

		expect(match).toBeNull();
		ENTITY_REF_RE.lastIndex = 0;
	});
});
