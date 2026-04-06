/**
 * Internal link utilities tests
 *
 * Verifies the package's internal `id:` link helpers preserve the expected
 * relationship between link detection, FileId extraction, and href creation.
 *
 * Key behaviors:
 * - `isInternalLink` recognizes only the internal `id:` scheme
 * - `getTargetFileId` strips the scheme prefix without altering the id
 * - `makeInternalHref` round-trips with the other helpers
 */
import { describe, expect, test } from 'bun:test';
import type { FileId } from './ids.js';
import {
	convertInternalLinksToWikilinks,
	convertWikilinksToInternalLinks,
	getTargetFileId,
	isInternalLink,
	makeInternalHref,
} from './links.js';

const SAMPLE_ID = '01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b' as FileId;

describe('isInternalLink', () => {
	test('returns true for id: scheme', () => {
		expect(isInternalLink(`id:${SAMPLE_ID}`)).toBe(true);
	});

	test('returns false for https URL', () => {
		expect(isInternalLink('https://example.com')).toBe(false);
	});

	test('returns false for empty string', () => {
		expect(isInternalLink('')).toBe(false);
	});

	test('returns false for bare GUID without prefix', () => {
		expect(isInternalLink(SAMPLE_ID)).toBe(false);
	});
});

describe('getTargetFileId', () => {
	test('extracts FileId from id: href', () => {
		expect(getTargetFileId(`id:${SAMPLE_ID}`)).toBe(SAMPLE_ID);
	});

	test('returns empty string as FileId when given bare id:', () => {
		expect(`${getTargetFileId('id:')}`).toBe('');
	});
});

describe('makeInternalHref', () => {
	test('produces id: prefixed href', () => {
		expect(makeInternalHref(SAMPLE_ID)).toBe(`id:${SAMPLE_ID}`);
	});

	test('round-trips with getTargetFileId', () => {
		const href = makeInternalHref(SAMPLE_ID);
		expect(getTargetFileId(href)).toBe(SAMPLE_ID);
	});

	test('round-trip: isInternalLink recognizes makeInternalHref output', () => {
		expect(isInternalLink(makeInternalHref(SAMPLE_ID))).toBe(true);
	});
});

describe('convertInternalLinksToWikilinks', () => {
	test('converts id: link to wikilink', () => {
		const body = 'See [Meeting Notes](id:abc-123) for details.';
		expect(convertInternalLinksToWikilinks(body)).toBe(
			'See [[Meeting Notes]] for details.',
		);
	});

	test('converts multiple id: links', () => {
		const body = '[A](id:aaa) and [B](id:bbb)';
		expect(convertInternalLinksToWikilinks(body)).toBe('[[A]] and [[B]]');
	});

	test('leaves external links untouched', () => {
		const body = '[Google](https://google.com)';
		expect(convertInternalLinksToWikilinks(body)).toBe(body);
	});

	test('handles mixed internal and external links', () => {
		const body = '[Notes](id:abc) and [Google](https://google.com)';
		expect(convertInternalLinksToWikilinks(body)).toBe(
			'[[Notes]] and [Google](https://google.com)',
		);
	});

	test('returns body unchanged when no links present', () => {
		const body = 'Just plain text.';
		expect(convertInternalLinksToWikilinks(body)).toBe(body);
	});
});

describe('convertWikilinksToInternalLinks', () => {
	const resolve = (name: string) => {
		const lookup: Record<string, string> = {
			'Meeting Notes': 'abc-123',
			'Project Plan': 'def-456',
		};
		return (lookup[name] as FileId) ?? null;
	};

	test('converts wikilink to id: link', () => {
		const body = 'See [[Meeting Notes]] for details.';
		expect(convertWikilinksToInternalLinks(body, resolve)).toBe(
			'See [Meeting Notes](id:abc-123) for details.',
		);
	});

	test('converts multiple wikilinks', () => {
		const body = '[[Meeting Notes]] and [[Project Plan]]';
		expect(convertWikilinksToInternalLinks(body, resolve)).toBe(
			'[Meeting Notes](id:abc-123) and [Project Plan](id:def-456)',
		);
	});

	test('leaves unresolved wikilinks as-is', () => {
		const body = '[[Unknown Page]]';
		expect(convertWikilinksToInternalLinks(body, resolve)).toBe(body);
	});

	test('handles mix of resolved and unresolved', () => {
		const body = '[[Meeting Notes]] and [[Unknown Page]]';
		expect(convertWikilinksToInternalLinks(body, resolve)).toBe(
			'[Meeting Notes](id:abc-123) and [[Unknown Page]]',
		);
	});

	test('round-trips with convertInternalLinksToWikilinks', () => {
		const original = '[Meeting Notes](id:abc-123)';
		const asWikilink = convertInternalLinksToWikilinks(original);
		expect(asWikilink).toBe('[[Meeting Notes]]');
		const backToLink = convertWikilinksToInternalLinks(asWikilink, resolve);
		expect(backToLink).toBe(original);
	});
});
