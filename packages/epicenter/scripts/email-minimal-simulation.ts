/**
 * Minimal Email Storage Simulation
 *
 * Tests YJS file size with minimal email data (no body) to measure overhead.
 *
 * @example
 * ```bash
 * bun packages/epicenter/scripts/email-minimal-simulation.ts 100000
 * ```
 */

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
const YJS_PATH = join(OUTPUT_DIR, 'emails-minimal.yjs');

if (!existsSync(OUTPUT_DIR)) {
	mkdirSync(OUTPUT_DIR, { recursive: true });
}

if (existsSync(YJS_PATH)) {
	rmSync(YJS_PATH);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(ms: number): string {
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}

function formatRate(count: number, ms: number): string {
	const rate = (count / ms) * 1000;
	if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k/s`;
	return `${rate.toFixed(0)}/s`;
}

const isTTY = process.stdout.isTTY;
const clearLine = () => {
	if (isTTY) {
		process.stdout.clearLine(0);
		process.stdout.cursorTo(0);
	}
};
const writeLine = (text: string) => {
	if (isTTY) {
		process.stdout.write(text);
	}
};

console.log('='.repeat(70));
console.log('Minimal Email Storage Simulation - YJS Overhead Test');
console.log('='.repeat(70));
console.log(`Emails to store: ${EMAIL_COUNT.toLocaleString()}`);
console.log(`Output path: ${YJS_PATH}`);
console.log('='.repeat(70));
console.log('');

// Minimal email definition
const emailDefinition = defineWorkspace({
	name: 'Email Minimal Simulation',
	description: '',
	icon: null,
	tables: [
		table({
			id: 'emails',
			name: 'Emails',
			description: 'Email messages for storage simulation',
			fields: [
				id(),
				text({ id: 'sender' }),
				text({ id: 'subject' }),
				text({ id: 'received_at' }),
				integer({ id: 'read', default: 0 }),
			] as const,
		}),
	],
	kv: [],
});

console.log('Creating client...');
const totalStart = performance.now();
const head = createHeadDoc({ workspaceId: 'emails-minimal', providers: {} });
await using client = await createClient(head)
	.withDefinition(emailDefinition)
	.withExtensions({
		persistence: (ctx) =>
			persistence(ctx, {
				filePath: YJS_PATH,
			}),
	});
console.log('Client created\n');

// Sample email for size estimation
const sampleEmail = {
	id: generateId(),
	sender: 'test@example.com',
	subject: 'Test Subject',
	received_at: new Date().toISOString(),
	read: 0,
};
console.log('Minimal email structure:');
console.log(`  - JSON size: ${JSON.stringify(sampleEmail).length} bytes`);
console.log('');

console.log('Inserting emails...');
let inserted = 0;
const insertStart = performance.now();
const sizeSnapshots: { count: number; size: number; elapsed: number }[] = [];

while (inserted < EMAIL_COUNT) {
	const batchStart = performance.now();
	const batchCount = Math.min(BATCH_SIZE, EMAIL_COUNT - inserted);

	const emails = [];
	for (let i = 0; i < batchCount; i++) {
		const idx = inserted + i;
		emails.push({
			id: generateId(),
			sender: `user${idx % 100}@example.com`,
			subject: `Email ${idx}`,
			received_at: new Date().toISOString(),
			read: idx % 3 === 0 ? 1 : 0,
		});
	}

	client.tables.get('emails').upsertMany(emails);
	inserted += batchCount;

	const batchElapsed = performance.now() - batchStart;
	const totalElapsed = performance.now() - insertStart;

	clearLine();
	writeLine(
		`Inserted: ${inserted.toLocaleString()}/${EMAIL_COUNT.toLocaleString()} (${formatRate(batchCount, batchElapsed)}, elapsed: ${formatTime(totalElapsed)})`,
	);

	if (inserted % 10_000 === 0 || inserted === EMAIL_COUNT) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		if (existsSync(YJS_PATH)) {
			const stats = statSync(YJS_PATH);
			sizeSnapshots.push({
				count: inserted,
				size: stats.size,
				elapsed: totalElapsed,
			});
		}
	}
}

clearLine();
const totalElapsed = performance.now() - totalStart;
console.log(
	`Inserted: ${inserted.toLocaleString()} emails in ${formatTime(totalElapsed)}`,
);
console.log(`Average rate: ${formatRate(inserted, totalElapsed)}`);
console.log('');

console.log('Waiting for YJS persistence to complete (3s)...');
await new Promise((resolve) => setTimeout(resolve, 3000));

console.log('');
console.log('='.repeat(70));
console.log('RESULTS (Minimal Emails - No Body)');
console.log('='.repeat(70));

if (existsSync(YJS_PATH)) {
	const stats = statSync(YJS_PATH);
	const bytesPerEmail = stats.size / EMAIL_COUNT;

	console.log(`YJS file: ${YJS_PATH}`);
	console.log(`YJS file size: ${formatBytes(stats.size)}`);
	console.log(`Emails stored: ${EMAIL_COUNT.toLocaleString()}`);
	console.log(`Bytes per email: ${bytesPerEmail.toFixed(2)}`);
	console.log('');

	console.log('Size Scaling Analysis:');
	console.log('-'.repeat(50));
	console.log('| Emails    | File Size   | Bytes/Email | Elapsed  |');
	console.log('-'.repeat(50));

	for (const snapshot of sizeSnapshots) {
		const bytesPerItem = snapshot.size / snapshot.count;
		console.log(
			`| ${snapshot.count.toLocaleString().padStart(9)} | ${formatBytes(snapshot.size).padStart(11)} | ${bytesPerItem.toFixed(2).padStart(11)} | ${formatTime(snapshot.elapsed).padStart(8)} |`,
		);
	}

	console.log('-'.repeat(50));
} else {
	console.log(`YJS file not found at ${YJS_PATH}`);
}

console.log('');
console.log('Simulation complete!');
