/**
 * Dogfood the increment-1 pipeline against a real folder of markdown.
 *
 *   bun scripts/inspect.ts [folder]   (default: ./sample-vault/drafts)
 *
 * Reads the folder from disk (node fs, the dev/server side of the future
 * #platform/fs seam), runs `readFolder`, and prints the inferred columns, the
 * rows, and the unreadable files. This is the CLI proof that read -> parse ->
 * infer works on real files before the Tauri/Svelte GUI exists.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFolder } from '../src/lib/model/folder';

const dir = process.argv[2] ?? './sample-vault/drafts';

const names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();
const entries = await Promise.all(
	names.map(async (name) => ({ path: name, content: await readFile(join(dir, name), 'utf8') })),
);

const { rows, columns, unreadable } = readFolder(entries);

const cell = (value: unknown): string => {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
};

console.log(`\nFolder: ${dir}`);
console.log(`Files: ${entries.length}   Readable rows: ${rows.length}   Unreadable: ${unreadable.length}\n`);

console.log('Inferred columns:');
for (const c of columns) {
	console.log(`  ${c.key.padEnd(14)} ${c.kind}${c.array ? '[]' : ''}  (in ${c.count} files)`);
}

console.log('\nRows:');
const keys = columns.map((c) => c.key);
console.log('  ' + ['file', ...keys].map((k) => k.padEnd(16)).join(''));
for (const row of rows) {
	const cells = keys.map((k) => cell(row.frontmatter[k]).slice(0, 15).padEnd(16));
	console.log('  ' + row.path.padEnd(16) + cells.join(''));
}

if (unreadable.length) {
	console.log('\nUnreadable (would route to "Can\'t read"):');
	for (const u of unreadable) console.log(`  ${u.path.padEnd(16)} ${u.reason}`);
}
console.log('');
