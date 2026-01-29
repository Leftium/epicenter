/**
 * Email Storage Simulation
 *
 * Simulates storing large quantities of emails to measure YJS file size.
 *
 * @example
 * ```bash
 * # Run with default 10k emails
 * bun packages/epicenter/scripts/email-storage-simulation.ts
 *
 * # Custom count (e.g., 100k emails)
 * bun packages/epicenter/scripts/email-storage-simulation.ts 100000
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

// Configuration
const EMAIL_COUNT = Number(process.argv[2]) || 10_000;
const BATCH_SIZE = 1_000;

// Output directory
const OUTPUT_DIR = join(import.meta.dirname, '../.simulation');
const YJS_PATH = join(OUTPUT_DIR, 'emails.yjs');

// Ensure output directory exists
if (!existsSync(OUTPUT_DIR)) {
	mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Clean up previous run
if (existsSync(YJS_PATH)) {
	rmSync(YJS_PATH);
}

// Sample email data for realistic simulation
const SAMPLE_SENDERS = [
	'john.doe@example.com',
	'jane.smith@company.org',
	'support@service.io',
	'newsletter@updates.com',
	'admin@system.net',
	'notifications@app.dev',
	'hello@startup.co',
	'team@workspace.io',
	'noreply@automated.com',
	'contact@business.com',
];

const SAMPLE_SUBJECTS = [
	'Weekly Update: Project Status',
	'Meeting Reminder: Tomorrow at 10am',
	'Re: Your recent inquiry',
	'Important: Action required',
	'Newsletter: Top stories this week',
	'Invoice #12345 attached',
	'Welcome to our platform!',
	'Your order has shipped',
	'Password reset request',
	'Collaboration invite',
	'Review requested: Pull Request #42',
	'Daily digest: 5 new notifications',
	'Reminder: Subscription renewal',
	'Thank you for your purchase',
	'New comment on your post',
];

// Generate random email body (varying lengths)
function generateEmailBody(index: number): string {
	const paragraphs = 1 + (index % 5); // 1-5 paragraphs
	const lines: string[] = [];

	for (let p = 0; p < paragraphs; p++) {
		const sentences = 2 + (index % 4); // 2-5 sentences per paragraph
		const paragraph: string[] = [];

		for (let s = 0; s < sentences; s++) {
			const words = 10 + ((index + s) % 20); // 10-29 words per sentence
			const sentence = Array.from(
				{ length: words },
				(_, w) =>
					[
						'Lorem',
						'ipsum',
						'dolor',
						'sit',
						'amet',
						'consectetur',
						'adipiscing',
						'elit',
						'sed',
						'do',
						'eiusmod',
						'tempor',
						'incididunt',
						'ut',
						'labore',
						'et',
						'dolore',
						'magna',
						'aliqua',
						'enim',
					][(index + w) % 20],
			).join(' ');
			paragraph.push(sentence + '.');
		}

		lines.push(paragraph.join(' '));
	}

	return lines.join('\n\n');
}

// Generate a random email
function generateEmail(index: number) {
	const timestamp = new Date(
		Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000,
	).toISOString();

	return {
		id: generateId(),
		sender: SAMPLE_SENDERS[index % SAMPLE_SENDERS.length] ?? '',
		recipient: 'me@example.com',
		subject:
			(SAMPLE_SUBJECTS[index % SAMPLE_SUBJECTS.length] ?? '') +
			` (${index + 1})`,
		body: generateEmailBody(index),
		received_at: timestamp,
		read: index % 3 === 0 ? 1 : 0, // 33% read
		starred: index % 10 === 0 ? 1 : 0, // 10% starred
		folder: ['inbox', 'archive', 'sent', 'drafts'][index % 4] ?? 'inbox',
	};
}

// Format helpers
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

// Progress output helpers
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
console.log('Email Storage Simulation - YJS File Size Test');
console.log('='.repeat(70));
console.log(`Emails to store: ${EMAIL_COUNT.toLocaleString()}`);
console.log(`Batch size: ${BATCH_SIZE.toLocaleString()}`);
console.log(`Output path: ${YJS_PATH}`);
console.log('='.repeat(70));
console.log('');

// Define the email definition
const emailDefinition = defineWorkspace({
	name: 'Email Storage Simulation',
	description: '',
	icon: null,
	tables: {
		emails: table('emails', {
			name: 'Emails',
			description: 'Email messages for storage simulation',
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

// Create the client
console.log('Creating client...');
const totalStart = performance.now();
const head = createHeadDoc({ workspaceId: 'emails', providers: {} });
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
const sampleEmail = generateEmail(0);
const sampleSize = JSON.stringify(sampleEmail).length;
console.log('Sample email structure:');
console.log(`  - Sender: ${sampleEmail.sender}`);
console.log(`  - Subject: ${sampleEmail.subject}`);
console.log(`  - Body length: ${sampleEmail.body.length} chars`);
console.log(`  - JSON size: ${sampleSize} bytes`);
console.log('');

// Insert emails in batches
console.log('Inserting emails...');
let inserted = 0;
const insertStart = performance.now();

// Track file sizes at intervals
const sizeSnapshots: { count: number; size: number; elapsed: number }[] = [];

while (inserted < EMAIL_COUNT) {
	const batchStart = performance.now();
	const batchCount = Math.min(BATCH_SIZE, EMAIL_COUNT - inserted);

	// Generate batch of emails
	const emails = [];
	for (let i = 0; i < batchCount; i++) {
		emails.push(generateEmail(inserted + i));
	}

	// Bulk upsert
	client.tables.get('emails').upsertMany(emails);
	inserted += batchCount;

	const batchElapsed = performance.now() - batchStart;
	const totalElapsed = performance.now() - insertStart;

	clearLine();
	writeLine(
		`Inserted: ${inserted.toLocaleString()}/${EMAIL_COUNT.toLocaleString()} (${formatRate(batchCount, batchElapsed)}, elapsed: ${formatTime(totalElapsed)})`,
	);

	// Snapshot at intervals (every 10k or at end)
	if (inserted % 10_000 === 0 || inserted === EMAIL_COUNT) {
		// Wait for persistence to catch up
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

// Final persistence wait
console.log('Waiting for YJS persistence to complete (3s)...');
await new Promise((resolve) => setTimeout(resolve, 3000));

// Final stats
console.log('');
console.log('='.repeat(70));
console.log('RESULTS');
console.log('='.repeat(70));

if (existsSync(YJS_PATH)) {
	const stats = statSync(YJS_PATH);
	const bytesPerEmail = stats.size / EMAIL_COUNT;

	console.log(`YJS file: ${YJS_PATH}`);
	console.log(`YJS file size: ${formatBytes(stats.size)}`);
	console.log(`Emails stored: ${EMAIL_COUNT.toLocaleString()}`);
	console.log(`Bytes per email: ${bytesPerEmail.toFixed(2)}`);
	console.log('');

	// Size scaling analysis
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
	console.log('');

	// Projections
	console.log('Projected file sizes (based on current bytes/email):');
	const projections = [10_000, 50_000, 100_000, 500_000, 1_000_000];
	for (const count of projections) {
		const projectedSize = count * bytesPerEmail;
		console.log(
			`  ${count.toLocaleString().padStart(12)} emails: ${formatBytes(projectedSize).padStart(10)}`,
		);
	}
} else {
	console.log(`YJS file not found at ${YJS_PATH}`);
}

console.log('');
console.log('Simulation complete!');
