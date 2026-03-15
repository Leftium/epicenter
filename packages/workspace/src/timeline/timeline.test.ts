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
import { createTimeline, readEntry } from './timeline.js';
import { restoreFromSnapshot } from './restore.js';
import type { DocumentHandle } from '../workspace/types.js';

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

/**
 * Build a minimal DocumentHandle from a Y.Doc for testing.
 * Mirrors the essential behavior of makeHandle in create-document.ts.
 */
function createTestHandle(ydoc: Y.Doc): DocumentHandle {
	const tl = createTimeline(ydoc);
	return {
		ydoc,
		get mode() {
			return tl.currentMode;
		},
		read() {
			return tl.readAsString();
		},
		write(text: string) {
			if (tl.currentMode === 'text') {
				const ytext = tl.currentEntry?.get('content') as Y.Text;
				ydoc.transact(() => {
					ytext.delete(0, ytext.length);
					ytext.insert(0, text);
				});
			} else {
				ydoc.transact(() => tl.pushText(text));
			}
		},
		asText() {
			throw new Error('Not implemented in test handle');
		},
		asRichText() {
			throw new Error('Not implemented in test handle');
		},
		asSheet() {
			throw new Error('Not implemented in test handle');
		},
		timeline: tl,
		batch(fn: () => void) {
			ydoc.transact(fn);
		},
		exports: {},
	};
}

/** Create a snapshot binary from a Y.Doc with content set up by the callback. */
function createSnapshotBinary(setup: (tl: ReturnType<typeof createTimeline>) => void): Uint8Array {
	const doc = new Y.Doc({ gc: false });
	setup(createTimeline(doc));
	const binary = Y.encodeStateAsUpdateV2(doc);
	doc.destroy();
	return binary;
}

describe('restoreFromSnapshot', () => {
	test('text → text (same mode): content matches, timeline length unchanged', () => {
		const liveDoc = new Y.Doc({ gc: false });
		const handle = createTestHandle(liveDoc);
		handle.timeline.pushText('original content');
		expect(handle.timeline.length).toBe(1);

		const binary = createSnapshotBinary((tl) => tl.pushText('restored content'));
		restoreFromSnapshot(handle, binary);

		expect(handle.read()).toBe('restored content');
		expect(handle.timeline.length).toBe(1);
		expect(handle.mode).toBe('text');
		liveDoc.destroy();
	});

	test('text → sheet (different mode): new entry pushed, content matches', () => {
		const liveDoc = new Y.Doc({ gc: false });
		const handle = createTestHandle(liveDoc);
		handle.timeline.pushSheet();
		expect(handle.timeline.length).toBe(1);

		const binary = createSnapshotBinary((tl) => tl.pushText('snapshot text'));
		restoreFromSnapshot(handle, binary);

		expect(handle.read()).toBe('snapshot text');
		expect(handle.mode).toBe('text');
		expect(handle.timeline.length).toBe(2);
		liveDoc.destroy();
	});

	test('sheet snapshot: restores sheet entry with columns and rows', () => {
		const liveDoc = new Y.Doc({ gc: false });
		const handle = createTestHandle(liveDoc);
		handle.timeline.pushText('some text');

		const csv = 'Name,Age\nAlice,30\nBob,25\n';
		const binary = createSnapshotBinary((tl) => tl.pushSheetFromCsv(csv));
		restoreFromSnapshot(handle, binary);

		expect(handle.mode).toBe('sheet');
		expect(handle.read()).toBe(csv);

		const entry = readEntry(handle.timeline.currentEntry);
		expect(entry.mode).toBe('sheet');
		if (entry.mode === 'sheet') {
			expect(entry.columns.size).toBe(2);
			expect(entry.rows.size).toBe(2);
		}
		liveDoc.destroy();
	});

	test('empty snapshot: no-op, no crash', () => {
		const liveDoc = new Y.Doc({ gc: false });
		const handle = createTestHandle(liveDoc);
		handle.timeline.pushText('should stay');

		const binary = createSnapshotBinary(() => {});
		restoreFromSnapshot(handle, binary);

		expect(handle.read()).toBe('should stay');
		expect(handle.timeline.length).toBe(1);
		liveDoc.destroy();
	});

	test('temp doc is destroyed even on corrupted binary', () => {
		const liveDoc = new Y.Doc({ gc: false });
		const handle = createTestHandle(liveDoc);
		handle.timeline.pushText('original');

		// Corrupted binary should throw but not hang
		expect(() => restoreFromSnapshot(handle, new Uint8Array([1, 2, 3]))).toThrow();

		// Live doc should be unchanged
		expect(handle.read()).toBe('original');
		liveDoc.destroy();
	});
});
