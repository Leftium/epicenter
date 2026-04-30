import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	DateTimeString,
	generateId,
	NoopWebSocket,
	type ProjectDir,
} from '@epicenter/workspace';
import { mintTestProjectDir } from '@epicenter/workspace/test-utils';
import { openFuji as openFujiDaemon } from './daemon.js';
import { openFuji as openFujiScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('fuji-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates entries the daemon wrote', () => {
		{
			using daemon = openFujiDaemon({
				getToken: async () => 'fake-token',
				device: { id: 'test-daemon', name: 'Fuji Daemon', platform: 'node' },
				projectDir: workdir,
				webSocketImpl: NoopWebSocket,
			});

			const now = DateTimeString.now();
			for (const title of ['first', 'second', 'third']) {
				daemon.tables.entries.set({
					id: generateId(),
					title,
					subtitle: '',
					type: [],
					tags: [],
					pinned: false,
					rating: 0,
					deletedAt: undefined,
					date: now,
					createdAt: now,
					updatedAt: now,
					_v: 2 as const,
				});
			}
		}

		using script = openFujiScript({
			getToken: async () => 'fake-token',
			projectDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const titles = script.tables.entries
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
