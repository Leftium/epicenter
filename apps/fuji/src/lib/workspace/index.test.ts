/**
 * Tests for Fuji schema helpers that pin durable document identifiers.
 */

import { describe, expect, test } from 'bun:test';
import { docGuid } from '@epicenter/workspace';
import { asEntryId, entryContentDocGuid, FUJI_ID } from './index.js';

describe('Fuji schema helpers', () => {
	test('entryContentDocGuid is deterministic per entry id', () => {
		const a = entryContentDocGuid(asEntryId('entry-1'));
		const b = entryContentDocGuid(asEntryId('entry-1'));
		const c = entryContentDocGuid(asEntryId('entry-2'));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.length).toBeGreaterThan(0);
	});

	test('entryContentDocGuid matches the generic docGuid shape', () => {
		const id = asEntryId('entry-1');
		expect(entryContentDocGuid(id)).toBe(
			docGuid({
				workspaceId: FUJI_ID,
				collection: 'entries',
				rowId: id,
				field: 'content',
			}),
		);
	});
});
