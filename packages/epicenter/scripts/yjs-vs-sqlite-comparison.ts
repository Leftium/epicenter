/**
 * YJS vs SQLite Storage Comparison
 *
 * Compares file sizes when storing identical data in YJS vs SQLite.
 *
 * @example
 * ```bash
 * bun packages/epicenter/scripts/yjs-vs-sqlite-comparison.ts 100000
 * ```
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { persistence } from '../src/extensions/persistence/desktop';
import {
	createClient,
	createHeadDoc,
	defineWorkspace,
	generateId,
	id,
	integer,
	table,
	text,
} from '../src/index';

const EMAIL_COUNT = Number(process.argv[2]) || 100_000;
const BATCH_SIZE = 1_000;

const OUTPUT_DIR = join(import.meta.dirname, '../.simulation');
const YJS_PATH = join(OUTPUT_DIR, 'comparison.yjs');
const SQLITE_PATH = join(OUTPUT_DIR, 'comparison.db');

// Ensure output directory exists
if (!existsSync(OUTPUT_DIR)) {
	mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Clean up previous runs
if (existsSync(YJS_PATH)) rmSync(YJS_PATH);
if (existsSync(SQLITE_PATH)) rmSync(SQLITE_PATH);

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

// Generate consistent email data
function generateEmail(index: number) {
	const timestamp = new Date(
		Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000,
	).toISOString();

	// Generate varying body lengths (50-500 chars)
	const bodyLength = 50 + (index % 450);
	const body =
		'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum '
			.repeat(3)
			.slice(0, bodyLength);

	return {
		id: generateId(),
		sender: `user${index % 100}@example.com`,
		recipient: 'me@example.com',
		subject: `Email Subject ${index + 1}`,
		body,
		received_at: timestamp,
		read: index % 3 === 0 ? 1 : 0,
		starred: index % 10 === 0 ? 1 : 0,
		folder: ['inbox', 'archive', 'sent', 'drafts'][index % 4] ?? 'inbox',
	};
}

console.log('='.repeat(70));
console.log('YJS vs SQLite Storage Comparison');
console.log('='.repeat(70));
console.log(`Records to store: ${EMAIL_COUNT.toLocaleString()}`);
console.log('='.repeat(70));
console.log('');

// Pre-generate all emails for fair comparison
console.log('Pre-generating email data...');
const emails: ReturnType<typeof generateEmail>[] = [];
for (let i = 0; i < EMAIL_COUNT; i++) {
	emails.push(generateEmail(i));
}

// Calculate raw JSON size
const jsonSize = emails.reduce((acc, e) => acc + JSON.stringify(e).length, 0);
console.log(`Raw JSON size: ${formatBytes(jsonSize)}`);
console.log('');

// ============================================
// SQLITE TEST
// ============================================
console.log('--- SQLite Test ---');
const sqliteStart = performance.now();

const db = new Database(SQLITE_PATH);
db.exec(`
	CREATE TABLE emails (
		id TEXT PRIMARY KEY,
		sender TEXT NOT NULL,
		recipient TEXT NOT NULL,
		subject TEXT NOT NULL,
		body TEXT NOT NULL,
		received_at TEXT NOT NULL,
		read INTEGER DEFAULT 0,
		starred INTEGER DEFAULT 0,
		folder TEXT DEFAULT 'inbox'
	)
`);

const insertStmt = db.prepare(`
	INSERT INTO emails (id, sender, recipient, subject, body, received_at, read, starred, folder)
	VALUES ($id, $sender, $recipient, $subject, $body, $received_at, $read, $starred, $folder)
`);

const insertMany = db.transaction((rows: typeof emails) => {
	for (const row of rows) {
		insertStmt.run({
			$id: row.id,
			$sender: row.sender,
			$recipient: row.recipient,
			$subject: row.subject,
			$body: row.body,
			$received_at: row.received_at,
			$read: row.read,
			$starred: row.starred,
			$folder: row.folder,
		});
	}
});

// Insert in batches
for (let i = 0; i < EMAIL_COUNT; i += BATCH_SIZE) {
	const batch = emails.slice(i, i + BATCH_SIZE);
	insertMany(batch);
}

db.close();

const sqliteElapsed = performance.now() - sqliteStart;
const sqliteStats = statSync(SQLITE_PATH);
console.log(`SQLite insert time: ${formatTime(sqliteElapsed)}`);
console.log(`SQLite file size: ${formatBytes(sqliteStats.size)}`);
console.log(
	`SQLite bytes/record: ${(sqliteStats.size / EMAIL_COUNT).toFixed(2)}`,
);
console.log('');

// ============================================
// YJS TEST
// ============================================
console.log('--- YJS Test ---');
const yjsStart = performance.now();

const emailDefinition = defineWorkspace({
	name: 'YJS vs SQLite Comparison',
	description: '',
	icon: null,
	tables: {
		emails: table('emails', {
			name: 'Emails',
			description: 'Email messages for comparison test',
			fields: [
				id(),
				text('sender'),
				text('recipient'),
				text('subject'),
				text('body'),
				text('received_at'),
				integer('read', { default: 0 }),
				integer('starred', { default: 0 }),
				text('folder', { default: 'inbox' }),
			] as const,
		}),
	},
	kv: {},
});

const head = createHeadDoc({ workspaceId: 'emails-compare', providers: {} });
await using client = await createClient(head)
	.withDefinition(emailDefinition)
	.withExtensions({
		persistence: (ctx) =>
			persistence(ctx, {
				filePath: YJS_PATH,
			}),
	});

// Insert in batches
for (let i = 0; i < EMAIL_COUNT; i += BATCH_SIZE) {
	const batch = emails.slice(i, i + BATCH_SIZE);
	client.tables.get('emails').upsertMany(batch);
}

// Wait for persistence
await new Promise((resolve) => setTimeout(resolve, 3000));

const yjsElapsed = performance.now() - yjsStart;
const yjsStats = statSync(YJS_PATH);
console.log(`YJS insert time: ${formatTime(yjsElapsed)}`);
console.log(`YJS file size: ${formatBytes(yjsStats.size)}`);
console.log(`YJS bytes/record: ${(yjsStats.size / EMAIL_COUNT).toFixed(2)}`);
console.log('');

// ============================================
// COMPARISON
// ============================================
console.log('='.repeat(70));
console.log('COMPARISON RESULTS');
console.log('='.repeat(70));
console.log('');

const sizeRatio = yjsStats.size / sqliteStats.size;
const overhead = yjsStats.size - sqliteStats.size;

console.log(`| Metric              | SQLite          | YJS             |`);
console.log(`|---------------------|-----------------|-----------------|`);
console.log(
	`| File Size           | ${formatBytes(sqliteStats.size).padStart(15)} | ${formatBytes(yjsStats.size).padStart(15)} |`,
);
console.log(
	`| Bytes/Record        | ${(sqliteStats.size / EMAIL_COUNT).toFixed(2).padStart(15)} | ${(yjsStats.size / EMAIL_COUNT).toFixed(2).padStart(15)} |`,
);
console.log(
	`| Insert Time         | ${formatTime(sqliteElapsed).padStart(15)} | ${formatTime(yjsElapsed).padStart(15)} |`,
);
console.log('');
console.log(`Raw JSON size:       ${formatBytes(jsonSize)}`);
console.log(
	`SQLite compression:  ${(jsonSize / sqliteStats.size).toFixed(2)}x smaller than JSON`,
);
console.log(
	`YJS vs SQLite:       ${sizeRatio.toFixed(2)}x larger (${formatBytes(overhead)} overhead)`,
);
console.log('');

// Projections
console.log('Projected sizes at scale:');
console.log('-'.repeat(50));
const projections = [10_000, 100_000, 500_000, 1_000_000];
const bytesPerRecordSqlite = sqliteStats.size / EMAIL_COUNT;
const bytesPerRecordYjs = yjsStats.size / EMAIL_COUNT;

for (const count of projections) {
	const sqliteProj = count * bytesPerRecordSqlite;
	const yjsProj = count * bytesPerRecordYjs;
	console.log(
		`${count.toLocaleString().padStart(12)} records: SQLite ${formatBytes(sqliteProj).padStart(10)} | YJS ${formatBytes(yjsProj).padStart(10)}`,
	);
}

console.log('');
console.log('Comparison complete!');
