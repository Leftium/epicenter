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
import { getTargetFileId, isInternalLink, makeInternalHref } from './links.js';

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
