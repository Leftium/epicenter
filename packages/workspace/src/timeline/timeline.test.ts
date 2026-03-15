/**
 * Timeline Tests
 *
 * Validates timeline behavior for sheet entries, CSV round-tripping,
 * mode conversion, and snapshot restore.
 */

import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createTimeline } from './timeline.js';

function setup() {
	return createTimeline(new Y.Doc());
}

describe('createTimeline - sheet entries', () => {
	test('asSheet on empty timeline creates sheet entry', () => {
		const tl = setup();
		tl.asSheet();
		expect(tl.currentMode).toBe('sheet');
	});

	test('asSheet on empty timeline creates empty columns and rows', () => {
		const tl = setup();
		const { columns, rows } = tl.asSheet();
		expect(columns).toBeInstanceOf(Y.Map);
		expect(rows).toBeInstanceOf(Y.Map);
		expect(columns.size).toBe(0);
		expect(rows.size).toBe(0);
	});

	test('asSheet on empty timeline increments length', () => {
		const tl = setup();
		expect(tl.length).toBe(0);
		tl.asSheet();
		expect(tl.length).toBe(1);
	});

	test('asSheet from CSV text populates columns from header', () => {
		const tl = setup();
		tl.write('Name,Age\nAlice,30\n');
		const { columns } = tl.asSheet();
		expect(columns.size).toBe(2);

		const colArray = Array.from(columns.values());
		const names = colArray.map((col) => col.get('name')).sort();
		expect(names).toEqual(['Age', 'Name']);
	});

	test('asSheet from CSV text populates rows from data', () => {
		const tl = setup();
		tl.write('Name,Age\nAlice,30\nBob,25\n');
		const { rows } = tl.asSheet();
		expect(rows.size).toBe(2);
	});

	test('read returns CSV for sheet entry', () => {
		const tl = setup();
		tl.write('Name,Age\nAlice,30\n');
		tl.asSheet();
		expect(tl.read()).toBe('Name,Age\nAlice,30\n');
	});

	test('round-trip: CSV text → asSheet → read matches original', () => {
		const tl = setup();
		const originalCsv =
			'Product,Price,Stock\nWidget,9.99,100\nGadget,24.99,50\n';
		tl.write(originalCsv);
		tl.asSheet();
		expect(tl.read()).toBe(originalCsv);
	});

	test('switching text to sheet to text updates current mode and content', () => {
		const tl = setup();
		tl.write('First entry');
		expect(tl.currentMode).toBe('text');
		expect(tl.length).toBe(1);

		tl.asSheet();
		expect(tl.currentMode).toBe('sheet');

		tl.write('Third entry');
		expect(tl.currentMode).toBe('text');
		expect(tl.read()).toBe('Third entry');
	});

	test('empty sheet returns empty string', () => {
		const tl = setup();
		tl.asSheet();
		expect(tl.read()).toBe('');
	});

	test('sheet with columns but no rows returns header only', () => {
		const tl = setup();
		tl.write('A,B,C\n');
		tl.asSheet();
		expect(tl.read()).toBe('A,B,C\n');
	});
});

/** Create a snapshot binary from a Y.Doc with content set up by the callback. */
function createSnapshotBinary(
	fn: (tl: ReturnType<typeof createTimeline>) => void,
): Uint8Array {
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
		tl.write('original content');
		expect(tl.length).toBe(1);

		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => s.write('restored content')),
		);

		expect(tl.read()).toBe('restored content');
		expect(tl.length).toBe(1);
		expect(tl.currentMode).toBe('text');
		doc.destroy();
	});

	test('sheet → text (different mode): new entry pushed', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.asSheet();
		const lengthAfterSetup = tl.length;

		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => s.write('snapshot text')),
		);

		expect(tl.read()).toBe('snapshot text');
		expect(tl.currentMode).toBe('text');
		expect(tl.length).toBe(lengthAfterSetup + 1);
		doc.destroy();
	});

	test('sheet snapshot: restores sheet entry with columns and rows', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.write('some text');

		const csv = 'Name,Age\nAlice,30\nBob,25\n';
		tl.restoreFromSnapshot(
			createSnapshotBinary((s) => {
				s.write(csv);
				s.asSheet();
			}),
		);

		expect(tl.currentMode).toBe('sheet');
		expect(tl.read()).toBe(csv);

		const entry = tl.currentEntry;
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
		tl.write('should stay');

		tl.restoreFromSnapshot(createSnapshotBinary(() => {}));

		expect(tl.read()).toBe('should stay');
		expect(tl.length).toBe(1);
		doc.destroy();
	});

	test('corrupted binary throws but does not corrupt live doc', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.write('original');

		expect(() => tl.restoreFromSnapshot(new Uint8Array([1, 2, 3]))).toThrow();

		expect(tl.read()).toBe('original');
		doc.destroy();
	});

	test('richtext snapshot: preserves formatting (bold, headings)', () => {
		const doc = new Y.Doc({ gc: false });
		const tl = createTimeline(doc);
		tl.write('placeholder');

		const binary = createSnapshotBinary((s) => {
			const fragment = s.asRichText();
			// Build: <heading>Title</heading><paragraph>Hello <bold>world</bold></paragraph>
			const heading = new Y.XmlElement('heading');
			const headingText = new Y.XmlText();
			headingText.insert(0, 'Title');
			heading.insert(0, [headingText]);
			const para = new Y.XmlElement('paragraph');
			const plainText = new Y.XmlText();
			plainText.insert(0, 'Hello ');
			const boldText = new Y.XmlText();
			boldText.insert(0, 'world', { bold: true });
			para.insert(0, [plainText, boldText]);
			fragment.insert(0, [heading, para]);
		});
		tl.restoreFromSnapshot(binary);

		expect(tl.currentMode).toBe('richtext');
		const entry = tl.currentEntry;
		if (entry.mode !== 'richtext') throw new Error('expected richtext');

		// Verify structure: 2 children (heading + paragraph)
		const children = entry.content.toArray();
		expect(children.length).toBe(2);

		// Verify heading preserved
		const restoredHeading = children[0] as Y.XmlElement;
		expect(restoredHeading.nodeName).toBe('heading');

		// Verify paragraph with bold formatting preserved
		const restoredPara = children[1] as Y.XmlElement;
		expect(restoredPara.nodeName).toBe('paragraph');
		const paraChildren = restoredPara.toArray();
		expect(paraChildren.length).toBe(2);
		const restoredBold = paraChildren[1] as Y.XmlText;
		const delta = restoredBold.toDelta();
		expect(delta).toEqual([{ insert: 'world', attributes: { bold: true } }]);

		doc.destroy();
	});
});
