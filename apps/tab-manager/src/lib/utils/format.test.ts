/**
 * Tab Display Formatting Tests
 *
 * Verifies timestamp helpers used by saved tabs and bookmarks after lifecycle
 * timestamps moved from epoch milliseconds to canonical UTC instants.
 *
 * Key behaviors:
 * - Instant comparisons sort newest rows first
 * - Relative-time display accepts canonical UTC instants
 */

/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/field';
import { compareInstantDesc, getRelativeTime } from './format';

test('compareInstantDesc sorts newest instants first', () => {
	const oldest = '2026-06-15T10:00:00.000Z' as InstantString;
	const newest = '2026-06-15T12:00:00.000Z' as InstantString;
	const middle = '2026-06-15T11:00:00.000Z' as InstantString;

	const sorted = [oldest, newest, middle].sort(compareInstantDesc);

	expect(sorted).toEqual([newest, middle, oldest]);
});

test('getRelativeTime formats canonical UTC instants', () => {
	const twoMinutesAgo = new Date(
		Date.now() - 120_000,
	).toISOString() as InstantString;

	expect(getRelativeTime(twoMinutesAgo)).toBe('2m ago');
});
