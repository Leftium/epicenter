/**
 * Tests for Fuji's durable document identifiers.
 *
 * The entry content child-doc guid is a sync-wire identity: browser editors,
 * daemon markdown rendering, and wipe paths must all resolve the same string,
 * and it must never change. It is derived by the workspace from the table name
 * and child-doc field, reachable on the unconnected root too.
 */

import { describe, expect, test } from 'bun:test';
import { asEntryId, fujiWorkspace } from './index.js';

describe('Fuji durable identifiers', () => {
	test('entry content child-doc guid is the durable wire identifier', () => {
		using workspace = fujiWorkspace.create();
		const docs = workspace.tables.entries.docs.content;

		expect(String(docs.guid(asEntryId('entry-1')))).toBe(
			'epicenter-fuji.entries.entry-1.content',
		);
		// Deterministic per id; distinct ids never collide.
		expect(docs.guid(asEntryId('entry-1'))).toBe(
			docs.guid(asEntryId('entry-1')),
		);
		expect(docs.guid(asEntryId('entry-1'))).not.toBe(
			docs.guid(asEntryId('entry-2')),
		);
	});
});
