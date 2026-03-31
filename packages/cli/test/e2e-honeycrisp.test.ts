/**
 * End-to-end test: Honeycrisp workspace through the CLI pipeline.
 *
 * Proves the full local companion flow without jsrepo, without auth,
 * without Cloudflare:
 *
 * 1. loadConfig() loads epicenter.config.ts with a default export client
 * 2. Table CRUD works (set, getAllValid)
 * 3. KV works (get, set)
 * 4. SQLite persistence survives process restart
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspace, dateTimeStringNow } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
import { loadConfig } from '../src/load-config';
import { definition } from './fixtures/honeycrisp-basic/epicenter.config';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/honeycrisp-basic');
const PERSISTENCE_DIR = join(FIXTURE_DIR, '.epicenter-test');

function dbPath(id: string) {
	return join(PERSISTENCE_DIR, `${id}.db`);
}

describe('e2e: honeycrisp workspace', () => {
	beforeAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	afterAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	test('loadConfig: loads default export as client', async () => {
		const result = await loadConfig(FIXTURE_DIR);

		expect(result.clients.length).toBeGreaterThan(0);

		const found = result.clients.find(
			(c) => c.id === 'epicenter.honeycrisp',
		);
		expect(found).toBeDefined();
		expect(result.configDir).toBe(FIXTURE_DIR);
	});

	test('table CRUD: write and read folders + notes', async () => {
		const client = createWorkspace(definition).withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(definition.id) }),
		);

		await client.whenReady;

		// Write a folder
		client.tables.folders.set({
			id: 'folder-1',
			name: 'Work Notes',
			icon: undefined,
			sortOrder: 0,
			_v: 1,
		});

		// Write a note
		const now = dateTimeStringNow();
		client.tables.notes.set({
			id: 'note-1',
			folderId: 'folder-1',
			title: 'Test Note',
			preview: 'This is a test note from the e2e test',
			pinned: false,
			deletedAt: undefined,
			wordCount: 8,
			createdAt: now,
			updatedAt: now,
			_v: 2,
		});

		// Verify reads
		const folders = client.tables.folders.getAllValid();
		expect(folders).toHaveLength(1);
		expect(folders[0]!.name).toBe('Work Notes');

		const notes = client.tables.notes.getAllValid();
		expect(notes).toHaveLength(1);
		expect(notes[0]!.title).toBe('Test Note');
		expect(notes[0]!.folderId).toBe('folder-1');

		await client.dispose();
	});

	test('persistence: data survives restart', async () => {
		// Re-open same workspace — should load persisted state from SQLite
		const client = createWorkspace(definition).withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(definition.id) }),
		);

		await client.whenReady;

		const folders = client.tables.folders.getAllValid();
		expect(folders).toHaveLength(1);
		expect(folders[0]!.name).toBe('Work Notes');

		const notes = client.tables.notes.getAllValid();
		expect(notes).toHaveLength(1);
		expect(notes[0]!.title).toBe('Test Note');

		await client.dispose();
	});

	test('KV: set, persist, read after restart', async () => {
		// Open, set KV values, destroy
		const client1 = createWorkspace(definition).withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(definition.id) }),
		);
		await client1.whenReady;

		client1.kv.set('sortBy', 'title');
		client1.kv.set('sidebarCollapsed', true);

		await client1.dispose();

		// Re-open and verify
		const client2 = createWorkspace(definition).withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(definition.id) }),
		);
		await client2.whenReady;

		expect(client2.kv.get('sortBy')).toBe('title');
		expect(client2.kv.get('sidebarCollapsed')).toBe(true);

		await client2.dispose();
	});
});
