/**
 * End-to-end test: Tab Manager workspace through the CLI pipeline.
 *
 * Unlike the honeycrisp fixture (inlined schema), this test imports
 * the real tab-manager workspace factory to verify cross-package
 * config loading works end-to-end.
 *
 * 1. loadConfig() loads epicenter.config.ts with a named export client
 * 2. Client has the correct workspace ID
 * 3. Table CRUD works (set, getAllValid)
 * 4. Portable actions work (devices.list)
 * 5. Persistence survives restart
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { generateId } from '@epicenter/workspace';
import { filesystemPersistence } from '@epicenter/workspace/extensions/sync/desktop';
import { definition, createTabManagerWorkspace } from '@epicenter/tab-manager/workspace';
import { loadConfig } from '../src/load-config';

const FIXTURE_DIR = join(import.meta.dir, 'fixtures/tab-manager');
const PERSISTENCE_DIR = join(FIXTURE_DIR, '.epicenter-test');

function dbPath(id: string) {
	return join(PERSISTENCE_DIR, `${id}.db`);
}

describe('e2e: tab-manager workspace', () => {
	beforeAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	afterAll(async () => {
		await rm(PERSISTENCE_DIR, { recursive: true, force: true });
	});

	test('loadConfig: loads named export as client', async () => {
		const result = await loadConfig(FIXTURE_DIR);

		expect(result.clients.length).toBe(1);
		expect(result.clients[0]!.id).toBe('epicenter.tab-manager');
		expect(result.configDir).toBe(FIXTURE_DIR);
	});

	test('table CRUD: write and read devices + bookmarks', async () => {
		const client = createTabManagerWorkspace().withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(definition.id) }),
		);

		await client.whenReady;

		const deviceId = generateId();
		client.tables.devices.set({
			id: deviceId,
			name: 'Chrome on macOS',
			lastSeen: new Date().toISOString(),
			browser: 'chrome',
			_v: 1,
		});

		const bookmarkId = generateId();
		client.tables.bookmarks.set({
			id: bookmarkId,
			url: 'https://epicenter.so',
			title: 'Epicenter',
			favIconUrl: undefined,
			description: undefined,
			sourceDeviceId: deviceId,
			createdAt: Date.now(),
			_v: 1,
		});

		const devices = client.tables.devices.getAllValid();
		expect(devices).toHaveLength(1);
		expect(devices[0]!.name).toBe('Chrome on macOS');
		expect(devices[0]!.browser).toBe('chrome');

		const bookmarks = client.tables.bookmarks.getAllValid();
		expect(bookmarks).toHaveLength(1);
		expect(bookmarks[0]!.url).toBe('https://epicenter.so');
		expect(bookmarks[0]!.title).toBe('Epicenter');

		await client.dispose();
	});

	test('portable actions: devices.list returns data', async () => {
		const client = createTabManagerWorkspace().withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(definition.id) }),
		);

		await client.whenReady;

		// Data persisted from previous test
		const result = client.actions.devices.list({});
		expect(result.devices).toHaveLength(1);
		expect(result.devices[0]!.browser).toBe('chrome');

		await client.dispose();
	});

	test('persistence: data survives restart', async () => {
		const client = createTabManagerWorkspace().withExtension(
			'persistence',
			filesystemPersistence({ filePath: dbPath(definition.id) }),
		);

		await client.whenReady;

		const devices = client.tables.devices.getAllValid();
		expect(devices).toHaveLength(1);
		expect(devices[0]!.name).toBe('Chrome on macOS');

		const bookmarks = client.tables.bookmarks.getAllValid();
		expect(bookmarks).toHaveLength(1);
		expect(bookmarks[0]!.url).toBe('https://epicenter.so');

		await client.dispose();
	});
});
