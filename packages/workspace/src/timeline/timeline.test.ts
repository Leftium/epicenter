/**
 * Timeline Tests
 *
 * Validates timeline behavior for sheet entries and CSV round-tripping.
 * These tests ensure sheet-mode content can be appended to history and serialized predictably.
 *
 * Key behaviors:
 * - Sheet entries initialize expected Yjs maps for columns and rows.
 * - CSV parse/serialize paths preserve logical sheet content.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createTimeline, readEntry, restoreFromSnapshot } from './timeline.js';

function setup() {
	return createTimeline(new Y.Doc());
}

describe('createTimeline - sheet entries', () => {
	test('pushSheet creates entry with type sheet', () => {
		const tl = setup();
		const entry = tl.pushSheet();
		expect(entry.get('type')).toBe('sheet');
	});

	test('pushSheet creates empty columns and rows Y.Maps', () => {
		const tl = setup();
		const entry = tl.pushSheet();
		const columns = entry.get('columns') as Y.Map<Y.Map<string>>;
		const rows = entry.get('rows') as Y.Map<Y.Map<string>>;
		expect(columns).toBeInstanceOf(Y.Map);
		expect(rows).toBeInstanceOf(Y.Map);
		expect(columns.size).toBe(0);
		expect(rows.size).toBe(0);
	});

	test('pushSheet increments timeline length', () => {
		const tl = setup();
		expect(tl.length).toBe(0);
		tl.pushSheet();
		expect(tl.length).toBe(1);
	});

	test('currentMode returns sheet after pushSheet', () => {
		const tl = setup();
		tl.pushSheet();
		expect(tl.currentMode).toBe('sheet');
	});

	test('pushSheetFromCsv populates columns from header', () => {
		const tl = setup();
		tl.pushSheetFromCsv('Name,Age\nAlice,30\n');
		const entry = tl.currentEntry;
		expect(entry).toBeDefined();
		if (!entry) return;
		const columns = entry.get('columns') as Y.Map<Y.Map<string>>;
		expect(columns.size).toBe(2);

		const colArray = Array.from(columns.values());
		const names = colArray.map((col) => col.get('name')).sort();
		expect(names).toEqual(['Age', 'Name']);
	});

	test('pushSheetFromCsv populates rows from data', () => {
		const tl = setup();
		tl.pushSheetFromCsv('Name,Age\nAlice,30\nBob,25\n');
		const entry = tl.currentEntry;
		expect(entry).toBeDefined();
		if (!entry) return;
		const rows = entry.get('rows') as Y.Map<Y.Map<string>>;
		expect(rows.size).toBe(2);
	});

	test('readAsString returns CSV for sheet entry', () => {
		const tl = setup();
		const csv = 'Name,Age\nAlice,30\n';
		tl.pushSheetFromCsv(csv);
		expect(tl.readAsString()).toBe(csv);
	});
	test('round-trip: pushSheetFromCsv → readAsString matches original', () => {
		const tl = setup();
		const originalCsv =
			'Product,Price,Stock\nWidget,9.99,100\nGadget,24.99,50\n';
		tl.pushSheetFromCsv(originalCsv);
		expect(tl.readAsString()).toBe(originalCsv);
	});

	test('switching text to sheet to text updates current mode and content', () => {
		const tl = setup();
		tl.pushText('First entry');
		expect(tl.currentMode).toBe('text');
		expect(tl.length).toBe(1);

		tl.pushSheet();
		expect(tl.currentMode).toBe('sheet');
		expect(tl.length).toBe(2);

		tl.pushText('Third entry');
		expect(tl.currentMode).toBe('text');
		expect(tl.length).toBe(3);
		expect(tl.readAsString()).toBe('Third entry');
	});

	test('empty sheet returns empty string', () => {
		const tl = setup();
		tl.pushSheet();
		expect(tl.readAsString()).toBe('');
	});

	test('sheet with columns but no rows returns header only', () => {
		const tl = setup();
		tl.pushSheetFromCsv('A,B,C\n');
		expect(tl.readAsString()).toBe('A,B,C\n');
	});
});

/** Create a snapshot binary from a Y.Doc with content set up by the callback. */
function createSnapshotBinary(fn: (tl: ReturnType<typeof createTimeline>) => void): Uint8Array {
	const doc = new Y.Doc({ gc: false });
	fn(createTimeline(doc));
	const binary = Y.encodeStateAsUpdateV2(doc);
	doc.destroy();
	return binary;
}

describe('restoreFromSnapshot', () => {
	test('text → text (same mode): content matches, timeline length unchanged', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.pushText('original content');
		expect(tl.length).toBe(1);

		restoreFromSnapshot(doc, createSnapshotBinary((s) => s.pushText('restored content')));

		expect(tl.readAsString()).toBe('restored content');
		expect(tl.length).toBe(1);
		expect(tl.currentMode).toBe('text');
		doc.destroy();
	});

	test('text → sheet (different mode): new entry pushed, content matches', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.pushSheet();
		expect(tl.length).toBe(1);

		restoreFromSnapshot(doc, createSnapshotBinary((s) => s.pushText('snapshot text')));

		expect(tl.readAsString()).toBe('snapshot text');
		expect(tl.currentMode).toBe('text');
		expect(tl.length).toBe(2);
		doc.destroy();
	});

	test('sheet snapshot: restores sheet entry with columns and rows', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.pushText('some text');

		const csv = 'Name,Age\nAlice,30\nBob,25\n';
		restoreFromSnapshot(doc, createSnapshotBinary((s) => s.pushSheetFromCsv(csv)));

		expect(tl.currentMode).toBe('sheet');
		expect(tl.readAsString()).toBe(csv);

		const entry = readEntry(tl.currentEntry);
		expect(entry.mode).toBe('sheet');
		if (entry.mode === 'sheet') {
			expect(entry.columns.size).toBe(2);
			expect(entry.rows.size).toBe(2);
		}
		doc.destroy();
	});

	test('empty snapshot: no-op, no crash', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.pushText('should stay');

		restoreFromSnapshot(doc, createSnapshotBinary(() => {}));

		expect(tl.readAsString()).toBe('should stay');
		expect(tl.length).toBe(1);
		doc.destroy();
	});

	test('corrupted binary throws but does not corrupt live doc', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.pushText('original');

		expect(() => restoreFromSnapshot(doc, new Uint8Array([1, 2, 3]))).toThrow();

		expect(tl.readAsString()).toBe('original');
		doc.destroy();
	});
});
