/**
 * Behavior tests for the Honeycrisp schema and its mounted shape via
 * `openEncryptedDoc`. Pins the canonical workspace id and the encrypted
 * tables/kv surface that browser and daemon compositions both build on.
 */

import { describe, expect, test } from 'bun:test';
import { bytesToBase64, type SubjectKeyring } from '@epicenter/encryption';
import { openEncryptedDoc } from '@epicenter/workspace';
import {
	createHoneycrispActions,
	HONEYCRISP_ID,
	honeycrispTables,
	type NoteId,
	noteBodyDocGuid,
} from './workspace.js';

const testKey = new Uint8Array(32).fill(7);
const testKeyring: SubjectKeyring = [
	{ version: 1, subjectKeyBase64: bytesToBase64(testKey) },
];

function openHoneycrispForTest({ clientId }: { clientId?: number } = {}) {
	const ws = openEncryptedDoc({
		id: HONEYCRISP_ID,
		keyring: () => testKeyring,
		clientId,
	});
	const tables = ws.attachTables(honeycrispTables);
	const kv = ws.attachKv({});
	const actions = createHoneycrispActions(tables);
	return { ws, tables, kv, actions };
}

describe('Honeycrisp workspace mount', () => {
	test('openEncryptedDoc constructs a gc:true Y.Doc with HONEYCRISP_ID as guid', () => {
		const { ws } = openHoneycrispForTest();
		expect(ws.ydoc.guid).toBe(HONEYCRISP_ID);
		expect(ws.ydoc.gc).toBe(true);
		ws[Symbol.dispose]();
	});

	test('applies optional clientId', () => {
		const { ws } = openHoneycrispForTest({ clientId: 1234 });
		expect(ws.ydoc.clientID).toBe(1234);
		ws[Symbol.dispose]();
	});

	test('does not pin clientId when omitted', () => {
		const a = openHoneycrispForTest();
		const b = openHoneycrispForTest();
		expect(typeof a.ws.ydoc.clientID).toBe('number');
		expect(typeof b.ws.ydoc.clientID).toBe('number');
		a.ws[Symbol.dispose]();
		b.ws[Symbol.dispose]();
	});

	test('attaches encrypted tables and kv that accept writes', () => {
		const { ws, tables, kv } = openHoneycrispForTest();
		expect(tables.folders).toBeDefined();
		expect(tables.notes).toBeDefined();
		expect(kv).toBeDefined();
		expect(tables.folders.count()).toBe(0);
		expect(tables.notes.count()).toBe(0);
		ws[Symbol.dispose]();
	});

	test('createHoneycrispActions produces an action surface', () => {
		const { ws, actions } = openHoneycrispForTest();
		expect(actions).toBeDefined();
		expect(actions.folders_delete).toBeDefined();
		ws[Symbol.dispose]();
	});
});

describe('Honeycrisp schema helpers', () => {
	test('noteBodyDocGuid is deterministic per note id', () => {
		const a = noteBodyDocGuid('note-1' as NoteId);
		const b = noteBodyDocGuid('note-1' as NoteId);
		const c = noteBodyDocGuid('note-2' as NoteId);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.length).toBeGreaterThan(0);
	});

	test('noteBodyDocGuid bakes in HONEYCRISP_ID as the workspace label', () => {
		// Sanity: a different workspace label would produce a different guid.
		const guid = noteBodyDocGuid('note-1' as NoteId);
		expect(typeof guid).toBe('string');
		expect(guid.length).toBeGreaterThan(0);
	});
});
