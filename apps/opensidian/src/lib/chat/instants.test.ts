/**
 * Chat Instant Helpers Tests
 *
 * Verifies ordering helpers for Opensidian chat timestamps after persisted
 * conversations and messages moved from epoch milliseconds to canonical UTC
 * instants.
 *
 * Key behaviors:
 * - Conversation timestamps sort newest first
 * - Message timestamps sort oldest first
 */

/// <reference types="bun" />

import { expect, test } from 'bun:test';
import type { InstantString } from '@epicenter/field';
import {
	compareInstantAsc,
	compareInstantDesc,
	dateToInstant,
} from './instants';

test('compareInstantDesc sorts conversations newest first', () => {
	const oldest = '2026-06-15T10:00:00.000Z' as InstantString;
	const newest = '2026-06-15T12:00:00.000Z' as InstantString;
	const middle = '2026-06-15T11:00:00.000Z' as InstantString;

	const sorted = [oldest, newest, middle].sort(compareInstantDesc);

	expect(sorted).toEqual([newest, middle, oldest]);
});

test('compareInstantAsc sorts messages oldest first', () => {
	const oldest = '2026-06-15T10:00:00.000Z' as InstantString;
	const newest = '2026-06-15T12:00:00.000Z' as InstantString;
	const middle = '2026-06-15T11:00:00.000Z' as InstantString;

	const sorted = [newest, oldest, middle].sort(compareInstantAsc);

	expect(sorted).toEqual([oldest, middle, newest]);
});

test('dateToInstant preserves Date values as canonical UTC instants', () => {
	expect(dateToInstant(new Date('2026-06-15T10:00:00.000Z'))).toBe(
		'2026-06-15T10:00:00.000Z' as InstantString,
	);
});
