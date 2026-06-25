/**
 * Unit tests for the pure manifest + naming helpers. These cover the string
 * logic that `tsc` cannot: deterministic YAML, round-tripping, content-addressed
 * download naming, and the `source_url` omission.
 */

import { expect, test } from 'bun:test';
import { parse } from 'yaml';
import {
	type BlobManifest,
	type BlobManifestEntry,
	downloadName,
	emptyManifest,
	parseManifest,
	stringifyManifest,
	upsertManifestEntry,
} from './blobs-manifest.js';

const SHA = 'a'.repeat(64);
const SHB = 'b'.repeat(64);

function entry(over: Partial<BlobManifestEntry> = {}): BlobManifestEntry {
	return {
		sha256: SHA,
		size_bytes: 4475420,
		content_type: 'video/mp4',
		archived_at: '2026-06-24T17:00:00.000Z',
		...over,
	};
}

test('downloadName content-addresses a URL download by hash + extension', () => {
	expect(downloadName({ sha256: SHA, contentType: 'video/mp4' })).toBe(
		`${SHA}.mp4`,
	);
});

test('downloadName falls back to the bare hash for an unmappable type', () => {
	expect(
		downloadName({ sha256: SHA, contentType: 'application/x-not-real' }),
	).toBe(SHA);
});

test('parseManifest reads a missing/blank lockfile as empty', () => {
	expect(parseManifest('')).toEqual(emptyManifest());
});

test('upsert + stringify round-trips through parse', () => {
	const manifest = upsertManifestEntry(
		emptyManifest(),
		'media/talk.mp4',
		entry({ source_url: 'https://www.youtube.com/watch?v=abc&t=10s' }),
	);
	const back = parseManifest(stringifyManifest(manifest));
	expect(back).toEqual(manifest);
});

test('stringifyManifest sorts paths for clean diffs', () => {
	let manifest: BlobManifest = emptyManifest();
	manifest = upsertManifestEntry(
		manifest,
		'z/last.mp4',
		entry({ sha256: SHB }),
	);
	manifest = upsertManifestEntry(manifest, 'a/first.mp4', entry());
	const parsed = parse(stringifyManifest(manifest)) as BlobManifest;
	expect(Object.keys(parsed.blobs)).toEqual(['a/first.mp4', 'z/last.mp4']);
});

test('stringifyManifest omits source_url for a local file', () => {
	const manifest = upsertManifestEntry(emptyManifest(), 'notes.txt', entry());
	const parsed = parse(stringifyManifest(manifest)) as {
		blobs: Record<string, Record<string, unknown>>;
	};
	expect('source_url' in (parsed.blobs['notes.txt'] ?? {})).toBe(false);
});
