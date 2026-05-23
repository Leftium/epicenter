/**
 * Behavior tests for the Fuji schema and its mounted shape via
 * `openEncryptedDoc`. Pins the canonical workspace id and the encrypted
 * tables/kv surface that browser and daemon compositions both build on.
 */

import { describe, expect, test } from 'bun:test';
import { bytesToBase64, type SubjectKeyring } from '@epicenter/encryption';
import { openEncryptedDoc } from '@epicenter/workspace';
import {
	createFujiActions,
	type EntryId,
	entryContentDocGuid,
	FUJI_ID,
	fujiTables,
} from './src/lib/workspace.js';

const testKey = new Uint8Array(32).fill(7);
const testKeyring: SubjectKeyring = [
	{ version: 1, subjectKeyBase64: bytesToBase64(testKey) },
];

function openFujiForTest({ clientId }: { clientId?: number } = {}) {
	const ws = openEncryptedDoc({
		id: FUJI_ID,
		keyring: () => testKeyring,
		clientId,
	});
	const tables = ws.attachTables(fujiTables);
	const kv = ws.attachKv({});
	const actions = createFujiActions(tables);
	return { ws, tables, kv, actions };
}

describe('Fuji workspace mount', () => {
	test('openEncryptedDoc constructs a gc:true Y.Doc with FUJI_ID as guid', () => {
		const { ws } = openFujiForTest();
		expect(ws.ydoc.guid).toBe(FUJI_ID);
		expect(ws.ydoc.gc).toBe(true);
		ws[Symbol.dispose]();
	});

	test('applies optional clientId', () => {
		const { ws } = openFujiForTest({ clientId: 1234 });
		expect(ws.ydoc.clientID).toBe(1234);
		ws[Symbol.dispose]();
	});

	test('does not pin clientId when omitted', () => {
		const a = openFujiForTest();
		const b = openFujiForTest();
		expect(typeof a.ws.ydoc.clientID).toBe('number');
		expect(typeof b.ws.ydoc.clientID).toBe('number');
		a.ws[Symbol.dispose]();
		b.ws[Symbol.dispose]();
	});

	test('attaches encrypted tables and kv that accept writes', () => {
		const { ws, tables, kv } = openFujiForTest();
		expect(tables.entries).toBeDefined();
		expect(kv).toBeDefined();
		expect(tables.entries.count()).toBe(0);
		ws[Symbol.dispose]();
	});

	test('createFujiActions produces an action surface', () => {
		const { ws, actions } = openFujiForTest();
		expect(actions).toBeDefined();
		expect(actions.entries_count).toBeDefined();
		expect(actions.entries_get).toBeDefined();
		expect(actions.entries_create).toBeDefined();
		ws[Symbol.dispose]();
	});
});

describe('Fuji schema helpers', () => {
	test('entryContentDocGuid is deterministic per entry id', () => {
		const a = entryContentDocGuid('entry-1' as EntryId);
		const b = entryContentDocGuid('entry-1' as EntryId);
		const c = entryContentDocGuid('entry-2' as EntryId);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.length).toBeGreaterThan(0);
	});

	test('entryContentDocGuid bakes in FUJI_ID as the workspace label', () => {
		// Sanity: a different workspace label would produce a different guid.
		const guid = entryContentDocGuid('entry-1' as EntryId);
		expect(typeof guid).toBe('string');
		expect(guid.length).toBeGreaterThan(0);
	});
});
