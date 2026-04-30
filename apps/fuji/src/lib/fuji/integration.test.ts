import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { ProjectDir } from '@epicenter/workspace';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import { defineFujiDaemon } from './daemon.js';
import { openFuji as openFujiScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('fuji-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates entries the daemon wrote', async () => {
		{
			const daemonDefinition = defineFujiDaemon({
				getToken: async () => 'fake-token',
				webSocketImpl: NoopWebSocket,
			});
			using daemon = await daemonDefinition.start({
				projectDir: workdir,
				configDir: workdir,
			});

			for (const title of ['first', 'second', 'third']) {
				daemon.actions.entries.create({ title });
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
