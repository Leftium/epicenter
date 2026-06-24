/**
 * Unit tests for the pure receipt + naming helpers. These cover the string
 * logic that `tsc` cannot (valid YAML, content-addressed naming) and would have
 * caught the earlier regex defect.
 */

import { expect, test } from 'bun:test';
import { parse } from 'yaml';
import {
	type BlobReceipt,
	toReceiptMarkdown,
	workingCopyName,
} from './blobs-receipt.js';

const SHA = 'a'.repeat(64);

/** Parse the `---`-delimited frontmatter block out of a receipt markdown. */
function frontmatterOf(md: string): Record<string, unknown> {
	expect(md.startsWith('---\n')).toBe(true);
	const end = md.indexOf('\n---\n', 4);
	expect(end).toBeGreaterThan(0);
	return parse(md.slice(4, end)) as Record<string, unknown>;
}

test('workingCopyName keeps a local file own basename', () => {
	expect(
		workingCopyName({
			localPath: '/a/b/clip.mp4',
			sha256: SHA,
			contentType: 'video/mp4',
		}),
	).toBe('clip.mp4');
});

test('workingCopyName content-addresses a URL download by hash + extension', () => {
	expect(workingCopyName({ sha256: SHA, contentType: 'video/mp4' })).toBe(
		`${SHA}.mp4`,
	);
});

test('workingCopyName falls back to the bare hash for an unmappable type', () => {
	expect(
		workingCopyName({ sha256: SHA, contentType: 'application/x-not-real' }),
	).toBe(SHA);
});

test('toReceiptMarkdown emits parseable frontmatter with a nested location', () => {
	const receipt: BlobReceipt = {
		sha256: SHA,
		source_url: 'https://www.youtube.com/watch?v=abc&t=10s',
		size_bytes: 4475420,
		content_type: 'video/mp4',
		location: {
			provider: 'epicenter',
			owner: 'usr_X',
			key: `owners/usr_X/blobs/${SHA}`,
		},
		encryption: 'none',
		archived_at: '2026-06-24T17:00:00.000Z',
	};
	const md = toReceiptMarkdown(receipt, 'clip.mp4');
	const fm = frontmatterOf(md);

	expect(fm.sha256).toBe(SHA);
	expect(fm.source_url).toBe('https://www.youtube.com/watch?v=abc&t=10s');
	expect(fm.size_bytes).toBe(4475420);
	expect(fm.location).toEqual({
		provider: 'epicenter',
		owner: 'usr_X',
		key: `owners/usr_X/blobs/${SHA}`,
	});
	expect(fm.encryption).toBe('none');
	expect(fm.archived_at).toBe('2026-06-24T17:00:00.000Z');
	expect(md).toContain('[clip.mp4](clip.mp4)');
});

test('toReceiptMarkdown omits source_url for a local file', () => {
	const receipt: BlobReceipt = {
		sha256: SHA,
		size_bytes: 5,
		content_type: 'text/plain',
		location: {
			provider: 'epicenter',
			owner: 'shared',
			key: `owners/shared/blobs/${SHA}`,
		},
		encryption: 'none',
		archived_at: '2026-06-24T17:00:00.000Z',
	};
	const fm = frontmatterOf(toReceiptMarkdown(receipt, 'notes.txt'));
	expect('source_url' in fm).toBe(false);
});
