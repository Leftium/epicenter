#!/usr/bin/env bun
/**
 * Smoke test: open honeycrisp workspace, write some data, read it back.
 *
 * Run from repo root:
 *   bun run packages/cli/test/fixtures/honeycrisp-basic/smoke-test.ts
 *
 * Or from this directory:
 *   bun run smoke-test.ts
 */

import { join } from 'node:path';
import { createWorkspace, dateTimeStringNow } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
import { loadConfig } from '../../../src/config/load-config';

const FIXTURE_DIR = import.meta.dir;
const DB_PATH = join(
	FIXTURE_DIR,
	'.epicenter',
	'persistence',
	'epicenter.honeycrisp.db',
);

console.log('─── Epicenter Honeycrisp Smoke Test ───\n');

// 1. Load config
console.log('1. Loading epicenter.config.ts...');
const { definitions, configDir } = await loadConfig(FIXTURE_DIR);
const definition = definitions[0]!;
console.log(`   ✓ Found workspace: ${definition.id}`);
console.log(`   Config dir: ${configDir}\n`);

// 2. Create client with persistence (no sync)
console.log('2. Creating workspace client with persistence...');
const client = createWorkspace(definition).withExtension(
	'persistence',
	filesystemPersistence({ filePath: DB_PATH }),
);
await client.whenReady;
console.log(`   ✓ Client ready. DB: ${DB_PATH}\n`);

// 3. Write a folder
console.log('3. Writing data...');
client.tables.folders.set({
	id: 'smoke-folder',
	name: 'Smoke Test Folder',
	icon: '🧪',
	sortOrder: 0,
	_v: 1,
});

const now = dateTimeStringNow();
client.tables.notes.set({
	id: 'smoke-note-1',
	folderId: 'smoke-folder',
	title: 'My First Note',
	preview: 'Written by the smoke test script',
	pinned: true,
	deletedAt: undefined,
	wordCount: 6,
	createdAt: now,
	updatedAt: now,
	_v: 2,
});

client.tables.notes.set({
	id: 'smoke-note-2',
	folderId: 'smoke-folder',
	title: 'Another Note',
	preview: 'Also from the smoke test',
	pinned: false,
	deletedAt: undefined,
	wordCount: 5,
	createdAt: now,
	updatedAt: now,
	_v: 2,
});

client.kv.set('sortBy', 'title');
client.kv.set('sidebarCollapsed', false);
console.log('   ✓ Wrote 1 folder, 2 notes, 2 KV entries\n');

// 4. Read it back
console.log('4. Reading data back...');
const folders = client.tables.folders.getAllValid();
const notes = client.tables.notes.getAllValid();
const sortBy = client.kv.get('sortBy');

console.log(`   Folders (${folders.length}):`);
for (const f of folders) {
	console.log(`     ${f.icon ?? '📁'} ${f.name} (id: ${f.id})`);
}

console.log(`   Notes (${notes.length}):`);
for (const n of notes) {
	console.log(`     ${n.pinned ? '📌' : '  '} ${n.title} — "${n.preview}"`);
}

console.log(`   KV sortBy: ${sortBy}`);

// 5. Destroy (flush to disk)
await client.destroy();
console.log('\n5. ✓ Client destroyed, data flushed to SQLite.');

// 6. Reopen and verify persistence
console.log('\n6. Reopening to verify persistence...');
const client2 = createWorkspace(definition).withExtension(
	'persistence',
	filesystemPersistence({ filePath: DB_PATH }),
);
await client2.whenReady;

const persistedNotes = client2.tables.notes.getAllValid();
console.log(`   ✓ Found ${persistedNotes.length} notes after restart`);

for (const n of persistedNotes) {
	console.log(`     ${n.pinned ? '📌' : '  '} ${n.title}`);
}

await client2.destroy();

console.log('\n─── Smoke test complete ───');
