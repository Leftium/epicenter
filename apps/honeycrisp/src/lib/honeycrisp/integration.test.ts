import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { DateTimeString, type ProjectDir } from '@epicenter/workspace';
import {
	mintTestProjectDir,
	NoopWebSocket,
} from '@epicenter/workspace/test-utils';
import type { NoteId } from '../workspace.js';
import { defineHoneycrispDaemon } from './daemon.js';
import { openHoneycrisp as openHoneycrispScript } from './script.js';

let workdir: ProjectDir;

beforeEach(() => {
	workdir = mintTestProjectDir('honeycrisp-integration-');
});

afterEach(() => {
	rmSync(workdir, { recursive: true, force: true });
});

describe('daemon to script handoff via Yjs log file', () => {
	test('script warm hydrates notes the daemon wrote', async () => {
		{
			const daemonDefinition = defineHoneycrispDaemon({
				getToken: async () => 'fake-token',
				peer: {
					id: 'test-daemon',
					name: 'Honeycrisp Daemon',
					platform: 'node',
				},
				webSocketImpl: NoopWebSocket,
			});
			using daemon = await daemonDefinition.start({
				projectDir: workdir,
				configDir: workdir,
			});

			const now = DateTimeString.now();
			const seed: { id: NoteId; title: string }[] = [
				{ id: 'a' as NoteId, title: 'first' },
				{ id: 'b' as NoteId, title: 'second' },
				{ id: 'c' as NoteId, title: 'third' },
			];
			for (const { id, title } of seed) {
				daemon.tables.notes.set({
					id,
					title,
					preview: '',
					pinned: false,
					deletedAt: undefined,
					wordCount: undefined,
					createdAt: now,
					updatedAt: now,
					_v: 2 as const,
				});
			}
		}

		using script = openHoneycrispScript({
			getToken: async () => 'fake-token',
			projectDir: workdir,
			webSocketImpl: NoopWebSocket,
		});
		const titles = script.tables.notes
			.getAllValid()
			.map((row) => row.title)
			.sort();
		expect(titles).toEqual(['first', 'second', 'third']);
	});
});
