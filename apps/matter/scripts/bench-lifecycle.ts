/**
 * Throwaway benchmark for the live-projection lifecycle decision.
 *
 * Measures, across folder sizes, the cost of each pipeline stage so we can lock in
 * "full reconcile now, incremental sync later" with numbers instead of adjectives:
 *
 *   parse   one file        -> the incremental per-file cost (STAGE 1)
 *   classify one row vs all  -> the asymmetry (STAGE 2 reconcile vs a single-row apply)
 *   project + JSON.stringify -> the IPC payload that crosses the Tauri boundary (STAGE 3)
 *   sqlite  DROP+CREATE+INS  -> the Rust-side write, via bun:sqlite on a temp file
 *
 * Run: cd apps/matter && bun run scripts/bench-lifecycle.ts
 */

import { Database } from 'bun:sqlite';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { classifyRow, classifyRows } from '../src/lib/core/conformance';
import { validateModel } from '../src/lib/core/model';
import { parseEntry, type Row } from '../src/lib/core/parse';
import { projectToSqlite } from '../src/lib/core/sqlite';

// A realistic model: 8 fields spanning string / url / datetime / select / integer /
// number / boolean / tags.
const MODEL_RAW = {
	fields: {
		title: { type: 'string', minLength: 1 },
		url: { type: 'string', format: 'uri' },
		created: { type: 'string', format: 'date-time' },
		status: { enum: ['draft', 'published', 'archived'] },
		priority: { type: 'integer', minimum: 1, maximum: 5 },
		score: { type: 'number' },
		pinned: { type: 'boolean' },
		tags: { type: 'array', items: { type: 'string' } },
	},
};

const { data: model, error } = validateModel(MODEL_RAW);
if (error) throw new Error(`bad model: ${error.message}`);
console.log(
	`model: ${model.fields.length} fields (${model.fields.map((f) => f.kind).join(', ')})`,
);

// ~1.5 KB of body, the realistic "one rich field" weight per file.
const BODY = `# Heading\n\n${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(
	25,
)}\n\n- a\n- b\n- c\n`;

/** ~80% valid, ~10% needs-value (title dropped), ~10% invalid (bad url / out-of-range). */
function makeRow(i: number): Row {
	const variant = i % 10;
	const fm: Record<string, unknown> = {
		title: `Note number ${i}`,
		url: variant === 8 ? 'not-a-url' : `https://example.com/notes/${i}`,
		created: '2026-06-05T12:00:00Z',
		status: ['draft', 'published', 'archived'][i % 3],
		priority: variant === 9 ? 99 : (i % 5) + 1,
		score: (i % 100) / 10,
		pinned: i % 2 === 0,
		tags: ['alpha', 'beta', 'gamma'].slice(0, (i % 3) + 1),
		author: 'braden', // extra (unmodeled)
		wordcount: 1200 + i, // extra (unmodeled)
	};
	if (variant === 7) delete fm.title; // needs-value
	return { name: `note-${i}.md`, frontmatter: fm, body: BODY };
}

/** Serialize a row back to markdown text, to bench the real parse cost. */
function toMarkdown(row: Row): string {
	const fm = Object.entries(row.frontmatter)
		.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
		.join('\n');
	return `---\n${fm}\n---\n${row.body}`;
}

/** Time `fn` for at least `minMs`, return ms-per-call. */
function bench(fn: () => void, minMs = 200): number {
	for (let i = 0; i < 3; i++) fn(); // warmup
	let iters = 0;
	const t0 = performance.now();
	do {
		fn();
		iters++;
	} while (performance.now() - t0 < minMs);
	return (performance.now() - t0) / iters;
}

const DB_PATH = join(tmpdir(), `matter-bench-${process.pid}.sqlite`);

/** Full rebuild against a real on-disk SQLite file (the rusqlite write proxy). */
function sqliteRebuild(proj: ReturnType<typeof projectToSqlite>): void {
	const db = new Database(DB_PATH);
	for (const stmt of proj.schema.split(';\n')) {
		if (stmt.trim()) db.run(stmt);
	}
	const insert = db.prepare(proj.insert);
	const tx = db.transaction((rows: (string | number)[][]) => {
		for (const r of rows) insert.run(...r);
	});
	tx(proj.rows);
	db.close();
}

// --- per-file (incremental) costs, size-independent ---
const oneRow = makeRow(1);
const oneMd = toMarkdown(oneRow);
const parsePer = bench(() => void parseEntry(oneRow.name, oneMd), 150);
const classifyOnePer = bench(() => void classifyRow(model.fields, oneRow), 150);
console.log('\n--- per-file (incremental, size-independent) ---');
console.log(`parse one file:        ${(parsePer * 1000).toFixed(1)} us`);
console.log(`classify one row:      ${(classifyOnePer * 1000).toFixed(1)} us`);

// --- per-folder (reconcile) costs, scaling with N ---
const SIZES = [100, 500, 1000, 5000, 10000, 50000];
console.log('\n--- per-folder (reconcile) costs by folder size ---');
console.log(
	['N'.padStart(7), 'classifyAll', 'project', 'stringify', 'payload', 'sqliteWrite'].join(
		'  ',
	),
);
for (const n of SIZES) {
	const rows = Array.from({ length: n }, (_, i) => makeRow(i));

	const classifyAll = bench(() => void classifyRows(model.fields, rows), 200);
	const conformance = classifyRows(model.fields, rows);

	const project = bench(
		() => void projectToSqlite('notes', model, conformance),
		200,
	);
	const proj = projectToSqlite('notes', model, conformance);

	const stringify = bench(() => void JSON.stringify(proj), 200);
	const payloadBytes = Buffer.byteLength(JSON.stringify(proj));

	const sqliteWrite = bench(() => sqliteRebuild(proj), 200);

	const fmt = (ms: number) => `${ms.toFixed(2)}ms`.padStart(11);
	console.log(
		[
			String(n).padStart(7),
			fmt(classifyAll),
			fmt(project).padStart(9),
			fmt(stringify).padStart(11),
			`${(payloadBytes / 1024).toFixed(0)}KB`.padStart(8),
			fmt(sqliteWrite).padStart(12),
		].join('  '),
	);
}

try {
	unlinkSync(DB_PATH);
} catch {}
console.log('\n(done)');
