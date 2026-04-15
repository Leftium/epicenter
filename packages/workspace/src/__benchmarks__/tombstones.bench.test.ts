/**
 * Tombstone Analysis Benchmarks
 *
 * Answers: "Do deletions leave residue? How much space do tombstones consume?"
 *
 * Measures binary size after delete-then-add cycles at various content sizes
 * (10K, 50K, 100K chars per row) to quantify tombstone overhead.
 */

import { describe, test } from 'bun:test';
import * as Y from 'yjs';
import { createTables } from '../workspace/create-tables.js';
import { formatBytes, heavyNoteDefinition, makeHeavyRow } from './helpers.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Tombstone Residue After Delete + Replace
// ═══════════════════════════════════════════════════════════════════════════════

describe('tombstone residue after delete + replace', () => {
	test('50K chars/row: delete 2 of 5, add 2 new', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const contentChars = 50_000;

		// Step 1: Insert 5 heavy rows
		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeHeavyRow(`doc-${i}`, contentChars));
		}
		const sizeWith5 = Y.encodeStateAsUpdate(ydoc).byteLength;

		// Step 2: Delete 2 rows (doc-1 and doc-3)
		tables.notes.delete('doc-1');
		tables.notes.delete('doc-3');
		const sizeAfterDelete = Y.encodeStateAsUpdate(ydoc).byteLength;

		// Step 3: Add 2 new rows
		tables.notes.set(makeHeavyRow('doc-5', contentChars));
		tables.notes.set(makeHeavyRow('doc-6', contentChars));
		const sizeAfterReplace = Y.encodeStateAsUpdate(ydoc).byteLength;

		const jsonPerRow = JSON.stringify(makeHeavyRow('x', contentChars)).length;

		console.log('\n=== TOMBSTONE ANALYSIS: 50K CHARS/ROW ===');
		console.log(`  JSON per row:                  ${formatBytes(jsonPerRow)}`);
		console.log(`  ─────────────────────────────────────────`);
		console.log(`  Step 1 — 5 rows:               ${formatBytes(sizeWith5)}`);
		console.log(
			`  Step 2 — delete 2 (3 remain):  ${formatBytes(sizeAfterDelete)}`,
		);
		console.log(
			`    Size freed:                  ${formatBytes(sizeWith5 - sizeAfterDelete)}`,
		);
		console.log(
			`    Tombstone residue:           ${formatBytes(sizeAfterDelete - Math.floor((sizeWith5 * 3) / 5))}`,
		);
		console.log(
			`  Step 3 — add 2 new (5 total):  ${formatBytes(sizeAfterReplace)}`,
		);
		console.log(
			`    vs original 5 rows:          ${sizeAfterReplace > sizeWith5 ? '+' : ''}${formatBytes(sizeAfterReplace - sizeWith5)} (${((sizeAfterReplace / sizeWith5 - 1) * 100).toFixed(2)}%)`,
		);
		console.log(`  ─────────────────────────────────────────`);
		console.log(
			`  Verdict: Tombstones are ${sizeAfterReplace <= sizeWith5 * 1.01 ? 'MINIMAL ✓' : sizeAfterReplace <= sizeWith5 * 1.05 ? 'SMALL ✓' : 'NOTICEABLE ⚠'}`,
		);
	});

	test('10K chars/row: delete 2 of 5, add 2 new', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const contentChars = 10_000;

		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeHeavyRow(`doc-${i}`, contentChars));
		}
		const sizeWith5 = Y.encodeStateAsUpdate(ydoc).byteLength;

		tables.notes.delete('doc-1');
		tables.notes.delete('doc-3');
		const sizeAfterDelete = Y.encodeStateAsUpdate(ydoc).byteLength;

		tables.notes.set(makeHeavyRow('doc-5', contentChars));
		tables.notes.set(makeHeavyRow('doc-6', contentChars));
		const sizeAfterReplace = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log('\n=== TOMBSTONE ANALYSIS: 10K CHARS/ROW ===');
		console.log(`  Step 1 — 5 rows:               ${formatBytes(sizeWith5)}`);
		console.log(
			`  Step 2 — delete 2 (3 remain):  ${formatBytes(sizeAfterDelete)}`,
		);
		console.log(
			`    Size freed:                  ${formatBytes(sizeWith5 - sizeAfterDelete)}`,
		);
		console.log(
			`  Step 3 — add 2 new (5 total):  ${formatBytes(sizeAfterReplace)}`,
		);
		console.log(
			`    vs original 5 rows:          ${sizeAfterReplace > sizeWith5 ? '+' : ''}${formatBytes(sizeAfterReplace - sizeWith5)} (${((sizeAfterReplace / sizeWith5 - 1) * 100).toFixed(2)}%)`,
		);
		console.log(
			`  Verdict: Tombstones are ${sizeAfterReplace <= sizeWith5 * 1.01 ? 'MINIMAL ✓' : sizeAfterReplace <= sizeWith5 * 1.05 ? 'SMALL ✓' : 'NOTICEABLE ⚠'}`,
		);
	});

	test('100K chars/row: delete 2 of 5, add 2 new', () => {
		const ydoc = new Y.Doc();
		const tables = createTables(ydoc, { notes: heavyNoteDefinition });

		const contentChars = 100_000;

		for (let i = 0; i < 5; i++) {
			tables.notes.set(makeHeavyRow(`doc-${i}`, contentChars));
		}
		const sizeWith5 = Y.encodeStateAsUpdate(ydoc).byteLength;

		tables.notes.delete('doc-1');
		tables.notes.delete('doc-3');
		const sizeAfterDelete = Y.encodeStateAsUpdate(ydoc).byteLength;

		tables.notes.set(makeHeavyRow('doc-5', contentChars));
		tables.notes.set(makeHeavyRow('doc-6', contentChars));
		const sizeAfterReplace = Y.encodeStateAsUpdate(ydoc).byteLength;

		console.log('\n=== TOMBSTONE ANALYSIS: 100K CHARS/ROW ===');
		console.log(`  Step 1 — 5 rows:               ${formatBytes(sizeWith5)}`);
		console.log(
			`  Step 2 — delete 2 (3 remain):  ${formatBytes(sizeAfterDelete)}`,
		);
		console.log(
			`    Size freed:                  ${formatBytes(sizeWith5 - sizeAfterDelete)}`,
		);
		console.log(
			`  Step 3 — add 2 new (5 total):  ${formatBytes(sizeAfterReplace)}`,
		);
		console.log(
			`    vs original 5 rows:          ${sizeAfterReplace > sizeWith5 ? '+' : ''}${formatBytes(sizeAfterReplace - sizeWith5)} (${((sizeAfterReplace / sizeWith5 - 1) * 100).toFixed(2)}%)`,
		);
		console.log(
			`  Verdict: Tombstones are ${sizeAfterReplace <= sizeWith5 * 1.01 ? 'MINIMAL ✓' : sizeAfterReplace <= sizeWith5 * 1.05 ? 'SMALL ✓' : 'NOTICEABLE ⚠'}`,
		);
	});
});
