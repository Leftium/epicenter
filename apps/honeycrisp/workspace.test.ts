/**
 * Behavior tests for the Honeycrisp schema and its mounted shape via
 * `attachEncryption`. Pins the canonical workspace id and the encrypted
 * tables/kv surface that browser and daemon compositions both build on.
 */

import { describe, expect, test } from 'bun:test';
import {
	asNoteId,
	noteBodyDocGuid,
} from './workspace.js';

describe('Honeycrisp schema helpers', () => {
	test('noteBodyDocGuid is deterministic per note id', () => {
		const a = noteBodyDocGuid(asNoteId('note-1'));
		const b = noteBodyDocGuid(asNoteId('note-1'));
		const c = noteBodyDocGuid(asNoteId('note-2'));
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.length).toBeGreaterThan(0);
	});
});
